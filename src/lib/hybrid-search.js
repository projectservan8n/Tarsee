import { cosineSimilarity } from "./embeddings.js";

export function hybridSearch({ keywordResults = [], vectorResults = [], memoryMap = {}, alpha = 0.6, topK = 10, useMmr = true, useTemporalDecay = true }) {
  const scores = new Map();
  const maxKeyword = Math.max(...keywordResults.map((r) => r.score || 0), 1);
  for (const r of keywordResults) {
    scores.set(r.id, { keyword: (r.score || 0) / maxKeyword, vector: 0, temporal: 1 });
  }
  for (const r of vectorResults) {
    const existing = scores.get(r.memoryId) || { keyword: 0, vector: 0, temporal: 1 };
    existing.vector = r.similarity;
    scores.set(r.memoryId, existing);
  }
  if (useTemporalDecay) {
    const now = Date.now();
    for (const [id, s] of scores) {
      const memory = memoryMap[id];
      if (memory?.updated_at || memory?.created_at) {
        const ts = new Date(memory.updated_at || memory.created_at).getTime();
        const ageHours = (now - ts) / (1000 * 60 * 60);
        s.temporal = Math.exp(-0.000962 * ageHours);
      }
    }
  }
  const combined = [];
  for (const [id, s] of scores) {
    const memory = memoryMap[id];
    if (!memory) continue;
    const hybridScore = (alpha * s.vector + (1 - alpha) * s.keyword) * s.temporal;
    combined.push({ id, content: memory.content, category: memory.category, score: hybridScore, keywordScore: s.keyword, vectorScore: s.vector });
  }
  combined.sort((a, b) => b.score - a.score);
  if (useMmr && combined.length > topK) return mmrRerank(combined, topK);
  return combined.slice(0, topK);
}

function mmrRerank(results, topK, lambda = 0.7) {
  const selected = [results[0]];
  const remaining = results.slice(1);
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      const maxSim = Math.max(...selected.map((s) => contentOverlap(remaining[i].content, s.content)));
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
    }
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

function contentOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
