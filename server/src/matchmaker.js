const QUEUE = 'ottv2:matchmaking';
const MATCH_SCRIPT = `
local own = ARGV[1]
local elo = tonumber(ARGV[2])
local gap = tonumber(ARGV[3])
local items = redis.call('ZRANGEBYSCORE', KEYS[1], elo-gap, elo+gap)
local best, bestDelta = nil, math.huge
for _, item in ipairs(items) do
  local sep = string.find(item, '|', 1, true)
  local id = string.sub(item, 1, sep-1)
  local rating = tonumber(string.sub(item, sep+1))
  if id ~= own and math.abs(rating-elo) < bestDelta then best, bestDelta = item, math.abs(rating-elo) end
end
if best then redis.call('ZREM', KEYS[1], best); redis.call('ZREM', KEYS[1], own .. '|' .. elo); return best end
redis.call('ZREM', KEYS[1], own .. '|' .. elo)
redis.call('ZADD', KEYS[1], elo, own .. '|' .. elo)
return false
`;

export async function enqueueOrMatch(redis, user, config) {
  const gap = Math.min(config.maxEloGap, config.currentGap || config.minEloGap);
  const found = await redis.eval(MATCH_SCRIPT, { keys: [QUEUE], arguments: [user.id, String(user.elo), String(gap)] });
  if (!found) return null;
  const [opponentId] = String(found).split('|');
  if (!opponentId || opponentId === user.id) return null;
  return { opponentId, queuedAt: Date.now() };
}

export async function cancelQueue(redis, userId) {
  const entries = await redis.zRange(QUEUE, 0, -1);
  const mine = entries.filter(item => item.startsWith(`${userId}|`));
  if (mine.length) await redis.zRem(QUEUE, mine);
}

export async function putBackInQueue(redis, userId) {
  // Elo is embedded in the existing member; matchmaking invokes this only with a known member.
  const entries = await redis.zRange(QUEUE, 0, -1);
  return entries.find(item => item.startsWith(`${userId}|`)) || null;
}
