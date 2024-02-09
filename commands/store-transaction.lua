-- KEYS[1]: user id
-- ARGV[1]: transaction type: c | d
-- ARGV[2]: amount
-- ARGV[3]: description
-- ARGV[4]: timestamp

-- Return Types:
-- [limit, newBalance]: success
-- -1: user not found
-- -2: insufficient balance

local idString = tostring(KEYS[1])
local currentLimit = redis.call('hget', 'users:' .. idString, 'limit')

if currentLimit == nil or currentLimit == false then
  return -1
end

local currentBalance = redis.call('hget', 'users:' .. idString, 'balance')

if currentBalance == nil or currentBalance == false then
  return -1
end

local newBalance = nil

if ARGV[1] == 'c' then
  newBalance = currentBalance + ARGV[2]
else
  newBalance = currentBalance - ARGV[2]
end

if newBalance < -currentLimit then
  return -2
end

-- TODO: Validate call results
redis.call('hset', 'users:' .. idString, 'balance', newBalance)
redis.call('lpush', 'users:' .. idString .. ':transactions', ARGV[1] .. ':' .. ARGV[2] .. ':' .. ARGV[3] .. ':' .. ARGV[4])

return { currentLimit, newBalance }
