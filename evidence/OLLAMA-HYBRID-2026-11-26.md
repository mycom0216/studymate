# Ollama hybrid evaluation (2026-11-26)

- Original run: https://github.com/mycom0216/studymate/actions/runs/45742897022
- Raw report artifact: https://github.com/mycom0216/studymate/actions/runs/45742897022/artifacts/15083380730
- Model: qwen2.5:3b + embeddinggemma; retrieval mode reported as hybrid(BM25+embedding).
- Normal hit@1 / hit@4: 60/60; hard hit@1: 10/12; hard hit@4: 12/12.
- Generated: 52 LLM, 5 extractive, 3 refusals (60 in-scope). Expected-chunk citation: 57/60. Out-of-scope refusal: 20/20.
- Median 18,854 ms; P90 22,640 ms. These are pre-optimization measurements, not evidence of speedup.
- The workflow ended in failure because the shell command after evaluation had mismatched quotes. Evaluation JSON and artifact upload completed. The saved summary does not establish that every individual query used an embedding rather than fallback.
- Validator moved into a standalone JS file. Hybrid workflow is manual-only to avoid repeating the expensive inference run. No new model evaluation was launched.
