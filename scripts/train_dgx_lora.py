#!/usr/bin/env python3
"""
Train a per-author LoRA adapter on the DGX Spark cluster for "source post" voice.

This runs on the DGX (GPU), NOT from the app. It reads a chat-format JSONL
(produced by `node scripts/fineTune.js export "<preset>" data.jsonl`) and trains
a small LoRA adapter on the same base model vLLM serves.

Install (on the DGX):
    pip install "torch" "transformers>=4.44" "peft>=0.12" "trl>=0.9" "datasets" "accelerate" "bitsandbytes"

Run:
    python scripts/train_dgx_lora.py \
        --data fine-tune/olha_siuta_bizdev.jsonl \
        --base-model Qwen/Qwen2.5-72B-Instruct \
        --out adapters/olha \
        --epochs 3

Serve with vLLM (enable LoRA, register the adapter):
    vllm serve Qwen/Qwen2.5-72B-Instruct --enable-lora \
        --lora-modules olha=adapters/olha

Then set the preset's adapter name so source generation uses it:
    UPDATE "TonePreset" SET "dgxLora"='olha' WHERE name LIKE 'Olha%';
"""
import argparse
import json


def load_chat(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line)["messages"])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="chat JSONL from fineTune.js export")
    ap.add_argument("--base-model", default="Qwen/Qwen2.5-72B-Instruct")
    ap.add_argument("--out", required=True, help="output adapter directory")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    args = ap.parse_args()

    import torch
    from datasets import Dataset
    from transformers import AutoTokenizer
    from peft import LoraConfig
    from trl import SFTConfig, SFTTrainer

    tok = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    convos = load_chat(args.data)
    texts = [tok.apply_chat_template(m, tokenize=False, add_generation_prompt=False) for m in convos]
    ds = Dataset.from_dict({"text": texts})
    print(f"Training on {len(ds)} examples from {args.data}")

    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    cfg = SFTConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        learning_rate=args.lr,
        bf16=torch.cuda.is_available(),
        logging_steps=5,
        save_strategy="epoch",
        dataset_text_field="text",
        max_seq_length=2048,
    )
    trainer = SFTTrainer(model=args.base_model, args=cfg, train_dataset=ds, peft_config=lora)
    trainer.train()
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)
    print(f"Saved LoRA adapter -> {args.out}")
    print("Serve: vllm serve <base> --enable-lora --lora-modules <name>=" + args.out)
    print('Then: UPDATE "TonePreset" SET "dgxLora"=\'<name>\' WHERE name LIKE \'<Author>%\';')


if __name__ == "__main__":
    main()
