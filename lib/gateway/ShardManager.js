"use strict";

const Collection = require("../util/Collection");
const Shard = require("./Shard");
const IORedis = require('ioredis');
const crypto = require('crypto');

class Redis extends IORedis {
  lock (key, expiry = 60e3) {
    if (!key.startsWith('lock:')) {
      key = `lock:${key}`;
    }

    return new Promise(async (resolve) => {
      const didSet = await super.set(
        key,
        crypto.randomBytes(3).toString('hex'),
        'PX',
        expiry,
        'NX'
      ) === 'OK';

      if (didSet) {
        resolve(() => super.del(key));
      } else {
        setTimeout(() => {
          resolve(this.lock(key, expiry));
        }, 100);
      }
    });
  }
}

const redis = new Redis({
  host: '',
  password: ''
});

module.exports = class ShardManager extends Collection {
  constructor(client) {
    super(Shard);
    this._client = client;
  }

  async connect(shard) {
    await new Promise(r => setTimeout(r, (shard.id % 16) * 1000));
    const name = `connect:${shard.id % 16}`;
    await redis.lock(name, 10500);
    console.log(`[${new Date().toLocaleString()}] consuming shard ${shard.id} for connect (lock: ${name})`)
    shard.connect();
    const shards = [ ...this.values() ];
    if (shards.every(shard => shard._connected)) {
      this._client.emit('spawnedLast');
    }
  }

  spawn(id) {
    let shard = this.get(id);
    if (!shard) {
      shard = this.add(new Shard(id, this._client));
      shard.on("ready", () => {
        /**
        * Fired when a shard turns ready
        * @event Client#shardReady
        * @prop {Number} id The ID of the shard
        */
        this._client.emit("shardReady", shard.id);
        if (this._client.ready) {
          return;
        }
        for (const other of this.values()) {
          if (!other.ready) {
            return;
          }
        }
        this._client.ready = true;
        this._client.startTime = Date.now();
        /**
        * Fired when all shards turn ready
        * @event Client#ready
        */
        this._client.emit("ready");
      }).on("resume", () => {
        /**
        * Fired when a shard resumes
        * @event Client#shardResume
        * @prop {Number} id The ID of the shard
        */
        this._client.emit("shardResume", shard.id);
        if (this._client.ready) {
          return;
        }
        for (const other of this.values()) {
          if (!other.ready) {
            return;
          }
        }
        this._client.ready = true;
        this._client.startTime = Date.now();
        this._client.emit("ready");
      }).on("disconnect", (error) => {
        /**
        * Fired when a shard disconnects
        * @event Client#shardDisconnect
        * @prop {Error?} error The error, if any
        * @prop {Number} id The ID of the shard
        */
        this._client.emit("shardDisconnect", error, shard.id);
        for (const other of this.values()) {
          if (other.ready) {
            return;
          }
        }
        this._client.ready = false;
        this._client.startTime = 0;
        /**
        * Fired when all shards disconnect
        * @event Client#disconnect
        */
        this._client.emit("disconnect");
      });
    }
    if (shard.status === "disconnected") {
      this.connect(shard);
    }
  }

  toJSON() {
    const base = {};
    for (const key in this) {
      if (this.hasOwnProperty(key) && !key.startsWith("_")) {
        if (this[key] && typeof this[key].toJSON === "function") {
          base[key] = this[key].toJSON();
        } else {
          base[key] = this[key];
        }
      }
    }
    return base;
  }
}