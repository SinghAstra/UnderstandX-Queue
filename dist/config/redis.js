"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const ioredis_1 = __importDefault(require("ioredis"));
dotenv_1.default.config();
const redisConnection = new ioredis_1.default(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
});
redisConnection.on("connect", () => {
    console.log("Connected to Redis");
});
redisConnection.on("error", (err) => {
    console.error("Redis Error:", err);
});
exports.default = redisConnection;
