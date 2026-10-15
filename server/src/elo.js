export function expectedScore(rating, opponentRating) {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

export function calculateElo(rating, opponentRating, score, kFactor = 20) {
  if (![0, 0.5, 1].includes(score)) throw new Error('score must be 0, 0.5, or 1');
  return Math.max(100, Math.round(rating + kFactor * (score - expectedScore(rating, opponentRating))));
}
