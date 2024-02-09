local seedInstalled = redis.call('get', 'seed')

if seedInstalled == nil or seedInstalled == false then
  redis.call('hset', 'users:1', 'limit', 100000)
  redis.call('hset', 'users:1', 'balance', 0)

  redis.call('hset', 'users:2', 'limit', 80000)
  redis.call('hset', 'users:2', 'balance', 0)

  redis.call('hset', 'users:3', 'limit', 1000000)
  redis.call('hset', 'users:3', 'balance', 0)

  redis.call('hset', 'users:4', 'limit', 10000000)
  redis.call('hset', 'users:4', 'balance', 0)

  redis.call('hset', 'users:5', 'limit', 500000)
  redis.call('hset', 'users:5', 'balance', 0)
end
