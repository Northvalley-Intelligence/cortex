<!--
DRAFT FOR FEROSH — Part 2 of the "CPU vs GPU Battle" series. NOT for publication as-is.

PART-2 SCOPE I INFERRED (and why):
  Part 2 = Arm C, the bge-reranker cross-encoder fine-tuned on ESCI — the FIRST
  fine-tuned arm, trained on the laptop's Apple-Metal (MPS) GPU via PyTorch
  (scripts/train_bge.py + bge_infer.py).

  Basis for the inference:
  1. Part 1's own closing teaser (published article,
     feroshjacob.github.io/posts/2026/08/23/cpu-vs-gpu-battle-part-1-search-relevance-easy-arms):
     "Next: bring in the GPU" — Part 2 promises GPU-based fine-tuning ("stop
     prompting a general model and start training one"); Part 3 forecasts
     LoRA-tuning with logit-reading.
  2. Ferosh's clarification (2026-08-29): Parts 2-3 are the LAPTOP-GPU (Metal/MPS)
     fine-tuned arms — Part 2 = bge cross-encoder, Part 3 = LoRA (Llama-3.2-3B, MLX);
     Part 4 = the EXTERNAL datacenter GPU (Round 2).
  The public series index page does not print explicit Part 2/3/4 titles beyond
  Part 1's teaser, so this split rests on (1) + (2) above. If the outline you have
  in hand says otherwise, flag it and I'll re-cut.

  [NEEDS FEROSH] — items to confirm before publish:
   - Title + permalink slug (I proposed one; match your slug convention).
   - Jekyll front matter (date, tags, series metadata) — placeholder below.
   - Whether to name the base checkpoint / link the repo publicly.

Every number below is cited to a repo journal or results/*.json on the
experiment/relevancy-replacement branch. No numbers are invented.
-->

---
# proposed front matter — [NEEDS FEROSH] confirm slug/date/tags to match Part 1
# title: "CPU vs GPU battle, Round 1: train the judge, don't prompt it"
# permalink: /posts/2026/xx/xx/cpu-vs-gpu-battle-part-2-train-the-judge
# series: cpu-vs-gpu-battle
# tags: [search-relevance, cross-encoder, fine-tuning, gpu, mps]
---

# CPU vs GPU battle, Round 1: train the judge, don't prompt it

*Part 2 of the series. In Part 1 we prompted a general-purpose model to grade
search relevance and watched exactly where it fell over. This time we stop
asking a generalist to guess and train a specialist instead — on the laptop's
own GPU. It becomes the first arm to actually beat the shipped on-device judge.*

## The Short Version

Part 1 left us with a prompted `llama3.2:3b` that grades e-commerce search
relevance on the 0–3 scale, is fast enough, and is honest-to-goodness *okay* —
but misses mostly by miscalibration, not by misunderstanding. The fix this round
is not a bigger prompt. It's a different tool: a **cross-encoder**,
`bge-reranker-v2-m3`, fine-tuned on Amazon's ESCI data with a small 4-class head
bolted on. Training runs on the MacBook's **Apple-Metal GPU** (PyTorch's MPS
backend) — the GPU finally does real work, on the same machine, no datacenter,
no API.

The result: it's the **first arm to beat the shipped on-device judge on both
independent test sets** — ESCI QWK **0.360** vs the prompted model's 0.288,
WANDS **0.299** vs 0.244 — while running at **~28 ms/pair** instead of seconds,
in ~1 GB of RAM instead of 5–6. That's roughly two orders of magnitude faster
and ~5× lighter, for *better* accuracy.

And — because this series reports the losses too — it's a **specialist**. It was
trained on ESCI product search, and you can see it leaning on that: its edge
shrinks on WANDS (furniture), a domain it never saw. Holding that thought is the
whole setup for Part 3.

*(Numbers: `results/bge_reranker__{esci,wands}_eval_sample.json`; journals
`06-arm-c-bge.md`, `08-final-comparison.md`.)*

## Where we left off: a calibration problem, not a comprehension problem

The Part 1 diagnosis was specific. The prompted model mostly *understood* the
query — it rarely called a perfect match irrelevant — it just put the boundary
in the wrong place, sliding a "2 — Relevant" to a "1 — Marginal" and back. A
calibration problem. When the failure is calibration, you don't need a smarter
conversationalist. You need something that has *seen the labels* and learned
where the lines actually are.

That's the pivot for this round: **stop prompting a general model and start
training one.** Prompting asks a model that was built to chat to improvise a
grading rubric on every call. Fine-tuning bakes the rubric in.

## The idea: a cross-encoder, not a chatbot

A cross-encoder is the unglamorous, right tool for pointwise relevance. Instead
of generating text, it takes the `(query, product title)` pair *together*,
lets every query token attend to every title token, and emits a score. We take
`BAAI/bge-reranker-v2-m3` — a reranker already good at "does this passage answer
this query" — and replace its scalar head with a **4-way classification head**,
one logit per grade: 0 Irrelevant, 1 Marginal, 2 Relevant, 3 Perfect. Inference
is a single forward pass and an **argmax over four numbers**.

One quiet but real consequence: there is **no text to parse**, so there are
**zero parse failures** — the field in the results file literally reads *"not
applicable — argmax over a 4-way classification head, no free-text parsing"*
(`results/bge_reranker__esci_eval_sample.json`). Part 1's prompted arm had to
strip `<think>` tags and fences and occasionally threw a pair away when the JSON
came back malformed. A classifier can't malform its output. That reliability is
part of why it's ~200× faster: no generation, no retries, no salvage.

## Training it — this is where the GPU actually shows up

Part 1's "GPU" was mostly Ollama quietly using Metal to run a 3B model. Here the
GPU does the thing GPUs are for: **training**. On the laptop's Apple-Metal GPU
(`CrossEncoder(model_dir, device="mps")` — `scripts/train_bge.py`), we fine-tune
on a **balanced 36k-row ESCI train split** with a **4k dev split**, for **3
epochs**. Best dev QWK peaked at **0.471** (`06-arm-c-bge.md`).

Everything is measured against **independent human-derived labels** — Amazon
ESCI and WANDS — never against the service's own past judgments, because ~92% of
those were produced by the same local model, so "agreeing" with them would
measure reproduction, not accuracy. (That's the circularity trap from Part 1,
and it still governs every number here.)

## Does it actually win?

Yes — and this is the first time in the series I get to write that without a
caveat swallowing the sentence. Held-out, on the same seeded test samples every
other arm was scored on:

| Arm | ESCI QWK | WANDS QWK | speed / pair | memory |
|---|---|---|---|---|
| Prompted `llama3.2:3b` (Part 1, ≈ shipped on-device judge) | 0.288 | 0.244 | ~1–5 s | ~5–6 GB |
| **bge cross-encoder, fine-tuned (this round)** | **0.360** | **0.299** | **~28 ms** | **~1 GB** |

*(ESCI QWK 0.360, 95% CI 0.325–0.391; WANDS 0.299, CI 0.262–0.334; warm median
27.9 ms/pair, p95 40 ms; peak RSS ~1.06 GB — all from
`results/bge_reranker__esci_eval_sample.json` / `…wands_eval_sample.json`.)*

Read it carefully, because the two axes both move the right way:

- **Accuracy up on both sets.** It beats the prompted judge on ESCI *and* on
  WANDS — and it never trained on WANDS. So it isn't just memorizing ESCI; the
  calibration it learned **carries** to a domain it hasn't seen. That's the
  direct fix for Part 1's failure mode.
- **Speed and memory down by orders of magnitude.** ~28 ms vs seconds is 1–2
  orders of magnitude; ~1 GB vs 5–6 GB is ~5× lighter. For a service that grades
  thousands of pairs, that's the difference between a batch job and a coffee
  break.

If you only wanted the deployment answer — *more accurate AND faster than the
on-device judge, on this machine* — this arm is it.

## Where it loses (because it does)

- **The absolute ceiling is still modest.** QWK 0.360 is *better*, not *good*.
  Pointwise relevance grading is genuinely hard — landing near ~0.3–0.5 is the
  neighborhood every arm in this experiment lives in. A win over the baseline is
  not a solved problem, and I'm not going to dress it up as one.
- **There's a real train/test gap.** Dev QWK peaked at **0.471**; held-out ESCI
  came in at **0.360** (`06-arm-c-bge.md`). The honest number is the held-out
  one. The 0.471 is what it looked like from the inside during training, and the
  gap is exactly the kind of thing that's tempting to quote and wrong to.
- **On the service's own past grades it "disagrees" — and that's correct.** On
  the Cortex-validation set bge scores only 0.305. But that set is ~92% grades
  from the prompted model, so a genuinely independent judge *should* diverge
  there. Low agreement is the arm behaving honestly, not failing.
- **It's a specialist, and the seams show.** Its edge on WANDS (0.299) is real
  but thinner than on its home turf, ESCI (0.360) — the classic shape of a model
  that fit its training domain well and travels less well. That crack is the
  entire premise of Part 3: a differently-trained arm that gives up some in-
  domain polish to generalize better. Watch this space.

## Honest caveats (they travel with every round)

- **Compare arms within a dataset, never across.** WANDS uses a coarser 3-class
  label space (no grade 1), so a WANDS number and an ESCI number aren't on the
  same ruler.
- **This is an on-device contest.** The shipped service default is cloud-first (a
  hosted Gemini model), which was *not* benchmarked here and would likely beat
  every laptop-bound arm. The claim is "no API, runs on this machine, and it beat
  the local judge" — not "beats the frontier cloud models."
- **Agreement with the service's own history is reproduction, not accuracy** —
  see the 0.305 above.
- **The GPU here is the Apple M-series integrated GPU (Metal), not a discrete
  card.** No hand-written CUDA or Metal kernels — PyTorch's MPS backend handles
  device dispatch. The whole thing fits on a laptop, which is the point.

## Next: read the logits

The cross-encoder wins the deployment tradeoff, but it's a purpose-built
classifier — and we just saw it lean on its training domain. What if we keep a
*generative* model — the same Llama-3.2 family from Part 1 — but instead of
prompting it, we **fine-tune a LoRA adapter and read the label-token logits
directly**, no free generation at all? Does a generalist-that-was-taught
generalize better out of domain than a specialist-that-was-trained? That's Part
3 — still on the laptop's GPU. Then, in Part 4, we finally leave the machine and
hand the problem to a real datacenter card to ask a different question entirely:
is the ~0.3–0.5 ceiling the *task*, or just the *size* of a laptop model?

*Same rules every round: independent labels, held-out numbers, and the losses
reported next to the wins.*
