import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2] ?? 'evidence/eval-ollama-hybrid.json', 'utf8'));
if (r.retrievalMode !== 'hybrid(BM25+embedding)') throw Error('Hybrid retrieval not active');
if (r.llm?.provider !== 'ollama:' + (process.env.OLLAMA_MODEL || 'qwen2.5:3b') || !(r.llm.generators.llm > 0)) throw Error('No confirmed model-generated answers');
const {rows, outRows, ...summary} = r.llm;
console.log(JSON.stringify(summary, null, 2));
