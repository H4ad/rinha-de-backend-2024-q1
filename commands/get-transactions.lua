-- KEYS[1]: user id

-- Return Types:
-- [limit, newBalance, transaction[]]: success
-- -1: user not found

local idString = tostring(KEYS[1])
local currentLimit = redis.call('hget', 'users:' .. idString, 'limit')

if currentLimit == nil or currentLimit == false then
  return -1
end

local currentBalance = redis.call('hget', 'users:' .. idString, 'balance')

if currentBalance == nil or currentBalance == false then
  return -1
end

local transactions = redis.call('lrange', 'users:' .. idString .. ':transactions', 0, -1)

return { currentLimit, currentBalance, transactions }
