#!/usr/bin/env python3
"""
Fine-tune BAAI/bge-reranker-v2-m3 on the ESCI-train stratified subset (handoff
03, Arm C). Framing: 4-way classification head (grades 0/1/2/3), CrossEntropyLoss
-- sentence-transformers' CrossEncoder + losses.CrossEntropyLoss supports this
directly (see losses.CrossEntropyLoss docstring: "Your model can be initialized
with num_labels > 1 to predict multiple classes"). Rejected regression+round:
classification lets the model's own softmax pick the class boundary rather than
imposing a fixed rounding rule on a continuous score, and the loss (cross-entropy)
matches the framing exactly -- no extra design choice to justify.

Data: data/bge_train_subset.jsonl (train, 36,000 pairs) / data/bge_dev_subset.jsonl
(dev, 4,000 pairs), both produced by scripts/prepare_bge_train_subset.mjs from
data/esci_train.jsonl ONLY (never esci_test.jsonl or any *_eval_sample.jsonl --
zero leakage from the sets this arm is scored on). Dev is used only to pick the
best checkpoint (early stopping); it is never reported as an eval metric.

Hardware: Apple M5, PyTorch MPS backend. Manual training loop (not
CrossEncoderTrainer) for full control over per-epoch timing/logging and simple
dev-based early stopping.

MEMORY CONSTRAINT (discovered live on this machine, see journal 06): this M5
has 17.2GB total RAM and was already running at ~12.7GB used swap from other
processes (Chrome, a VM, a node server, board.py, etc.) before training even
started. A full fine-tune of all 568M params (bs=16, max_length=96) measured
~40s/step (should be ~0.2s/step) -- the optimizer state for 568M trainable
params pushed the system into heavy swap thrashing. Fix: freeze the embeddings
+ bottom FREEZE_BOTTOM_LAYERS of the 24 XLM-RoBERTa-large encoder layers,
training only the top (24 - FREEZE_BOTTOM_LAYERS) layers + classifier head
(76.6M / 567.8M trainable, 13.5%). This is a standard partial-fine-tune (top
layers carry more task-specific signal; bottom layers stay close to the
pretrained multilingual representations bge-m3 was built on) and, measured
live, restored per-step time to ~0.19s (bs=16, max_length=96) with flat swap
usage. Not a compromise made lightly -- see journal 06 for the timing evidence
that motivated it.

Output: fine-tuned model saved to models/bge-esci/ (gitignored -- see .gitignore
and the journal for how to reproduce). Training log (hyperparams, per-epoch
loss/dev metrics/wall-clock) written to logs/bge_train_log.json.
"""
import json
import math
import random
import time
from pathlib import Path

import torch
from sentence_transformers import CrossEncoder
from sentence_transformers.cross_encoder.losses import CrossEntropyLoss
from transformers import get_linear_schedule_with_warmup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
MODEL_DIR = ROOT / "models" / "bge-esci"
LOG_PATH = ROOT / "logs" / "bge_train_log.json"

SEED = 42
MODEL_NAME = "BAAI/bge-reranker-v2-m3"
NUM_LABELS = 4
MAX_LENGTH = 96
BATCH_SIZE = 16
LR = 2e-5
WEIGHT_DECAY = 0.01
MAX_EPOCHS = 3
PATIENCE = 1  # stop if dev QWK does not improve over the best-so-far for this many epochs
GRAD_CLIP_NORM = 1.0
WARMUP_FRACTION = 0.1
FREEZE_BOTTOM_LAYERS = 18  # of 24 XLM-RoBERTa-large encoder layers; see memory-constraint note above


def load_jsonl(p):
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


def quadratic_weighted_kappa(gold, pred, min_grade=0, max_grade=3):
    n = max_grade - min_grade + 1
    confusion = [[0] * n for _ in range(n)]
    for g, p in zip(gold, pred):
        confusion[g - min_grade][p - min_grade] += 1
    gold_hist = [sum(row) for row in confusion]
    pred_hist = [sum(confusion[i][j] for i in range(n)) for j in range(n)]
    total = len(gold)
    if total == 0:
        return None
    weights = [[((i - j) ** 2) / ((n - 1) ** 2 or 1) for j in range(n)] for i in range(n)]
    numerator = 0.0
    denominator = 0.0
    for i in range(n):
        for j in range(n):
            observed = confusion[i][j] / total
            expected = (gold_hist[i] * pred_hist[j]) / (total * total)
            numerator += weights[i][j] * observed
            denominator += weights[i][j] * expected
    if denominator == 0:
        return 1.0 if numerator == 0 else 0.0
    return 1 - numerator / denominator


def batches(rows, batch_size, rand):
    idx = list(range(len(rows)))
    rand.shuffle(idx)
    for i in range(0, len(idx), batch_size):
        chunk = [rows[j] for j in idx[i : i + batch_size]]
        yield chunk


@torch.no_grad()
def evaluate_dev(model, dev_rows, batch_size=32):
    model.model.eval()
    preds = []
    for i in range(0, len(dev_rows), batch_size):
        chunk = dev_rows[i : i + batch_size]
        pairs = [(r["query"], r["title"]) for r in chunk]
        logits = model.predict(pairs, batch_size=len(pairs), show_progress_bar=False, apply_softmax=False, convert_to_numpy=True)
        pred_grades = logits.argmax(axis=-1)
        preds.extend(int(g) for g in pred_grades)
    gold = [r["grade"] for r in dev_rows]
    qwk = quadratic_weighted_kappa(gold, preds)
    acc = sum(1 for g, p in zip(gold, preds) if g == p) / len(gold)
    return qwk, acc


def main():
    random.seed(SEED)
    torch.manual_seed(SEED)

    train_rows = load_jsonl(DATA_DIR / "bge_train_subset.jsonl")
    dev_rows = load_jsonl(DATA_DIR / "bge_dev_subset.jsonl")
    print(f"train={len(train_rows)} dev={len(dev_rows)}")

    t_load0 = time.time()
    model = CrossEncoder(
        MODEL_NAME,
        num_labels=NUM_LABELS,
        max_length=MAX_LENGTH,
        device="mps",
        model_kwargs={"ignore_mismatched_sizes": True},
        # torch's MPS scaled_dot_product_attention kernel does not implement dropout
        # (NotImplementedError: "scaled_dot_product_attention for MPS does not support
        # dropout" -- hit live on this machine, torch 2.13.0). Zeroing dropout avoids the
        # unsupported code path entirely rather than falling back to the slower eager
        # attention implementation; acceptable for a partial fine-tune (bottom 18/24
        # layers frozen) with early stopping already guarding against overfitting.
        config_kwargs={"hidden_dropout_prob": 0.0, "attention_probs_dropout_prob": 0.0},
    )
    load_s = time.time() - t_load0
    print(f"model loaded in {load_s:.1f}s")

    # Freeze embeddings + bottom FREEZE_BOTTOM_LAYERS encoder layers (memory-constraint note above).
    backbone = model.model.roberta if hasattr(model.model, "roberta") else model.model.base_model
    for p in backbone.embeddings.parameters():
        p.requires_grad = False
    for i, layer in enumerate(backbone.encoder.layer):
        if i < FREEZE_BOTTOM_LAYERS:
            for p in layer.parameters():
                p.requires_grad = False
    trainable_params = sum(p.numel() for p in model.model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.model.parameters())
    print(f"trainable params: {trainable_params/1e6:.1f}M / {total_params/1e6:.1f}M ({100*trainable_params/total_params:.1f}%)")

    loss_fn = CrossEntropyLoss(model)
    optimizer = torch.optim.AdamW(
        [p for p in model.model.parameters() if p.requires_grad], lr=LR, weight_decay=WEIGHT_DECAY
    )

    steps_per_epoch = math.ceil(len(train_rows) / BATCH_SIZE)
    total_steps = steps_per_epoch * MAX_EPOCHS
    warmup_steps = max(1, int(total_steps * WARMUP_FRACTION))
    scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=warmup_steps, num_training_steps=total_steps)

    rand = random.Random(SEED)
    log = {
        "model_name": MODEL_NAME,
        "framing": "4-way classification (grades 0-3), CrossEntropyLoss",
        "num_labels": NUM_LABELS,
        "max_length": MAX_LENGTH,
        "batch_size": BATCH_SIZE,
        "lr": LR,
        "weight_decay": WEIGHT_DECAY,
        "max_epochs": MAX_EPOCHS,
        "patience": PATIENCE,
        "grad_clip_norm": GRAD_CLIP_NORM,
        "warmup_fraction": WARMUP_FRACTION,
        "seed": SEED,
        "n_train": len(train_rows),
        "n_dev": len(dev_rows),
        "device": "mps",
        "model_load_s": load_s,
        "freeze_bottom_layers": FREEZE_BOTTOM_LAYERS,
        "trainable_params": trainable_params,
        "total_params": total_params,
        "trainable_param_fraction": trainable_params / total_params,
        "epochs": [],
    }

    best_qwk = -1.0
    best_epoch = -1
    epochs_since_improve = 0
    t_train0 = time.time()

    for epoch in range(1, MAX_EPOCHS + 1):
        model.model.train()
        t_ep0 = time.time()
        total_loss = 0.0
        n_batches = 0
        for chunk in batches(train_rows, BATCH_SIZE, rand):
            queries = [r["query"] for r in chunk]
            titles = [r["title"] for r in chunk]
            labels = torch.tensor([r["grade"] for r in chunk], dtype=torch.long, device=model.device)
            optimizer.zero_grad()
            loss = loss_fn([queries, titles], labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(
                [p for p in model.model.parameters() if p.requires_grad], GRAD_CLIP_NORM
            )
            optimizer.step()
            scheduler.step()
            total_loss += loss.item()
            n_batches += 1
        ep_train_s = time.time() - t_ep0

        t_ev0 = time.time()
        dev_qwk, dev_acc = evaluate_dev(model, dev_rows)
        ep_eval_s = time.time() - t_ev0

        avg_loss = total_loss / n_batches
        print(f"epoch {epoch}: train_loss={avg_loss:.4f} dev_qwk={dev_qwk:.4f} dev_acc={dev_acc:.4f} train_s={ep_train_s:.1f} eval_s={ep_eval_s:.1f}")
        log["epochs"].append({
            "epoch": epoch,
            "avg_train_loss": avg_loss,
            "dev_qwk": dev_qwk,
            "dev_acc": dev_acc,
            "train_s": ep_train_s,
            "eval_s": ep_eval_s,
        })

        improved = dev_qwk > best_qwk
        if improved:
            best_qwk = dev_qwk
            best_epoch = epoch
            epochs_since_improve = 0
            MODEL_DIR.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(str(MODEL_DIR))
            print(f"  -> new best (dev_qwk={best_qwk:.4f}), saved to {MODEL_DIR}")
        else:
            epochs_since_improve += 1
            if epochs_since_improve > PATIENCE:
                print(f"  -> no improvement for {epochs_since_improve} epoch(s), stopping early")
                break

    total_train_s = time.time() - t_train0
    log["best_epoch"] = best_epoch
    log["best_dev_qwk"] = best_qwk
    log["total_train_wall_clock_s"] = total_train_s
    log["total_wall_clock_s_incl_load"] = total_train_s + load_s

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)
    print(f"Wrote {LOG_PATH}")
    print(f"Best epoch {best_epoch} dev_qwk={best_qwk:.4f}. Model saved to {MODEL_DIR}")


if __name__ == "__main__":
    main()
