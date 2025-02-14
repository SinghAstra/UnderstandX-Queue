"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
const redis_1 = __importDefault(require("../config/redis"));
const worker = new bullmq_1.Worker("exampleQueue", (job) => __awaiter(void 0, void 0, void 0, function* () {
    console.log(`Processing job ${job.id}:`, job.data);
    // Simulate work (e.g., sending email, resizing image)
    yield new Promise((res) => setTimeout(res, 3000));
    console.log(`Job ${job.id} completed.`);
}), { connection: redis_1.default });
worker.on("completed", (job) => {
    console.log(`✅ Job ${job.id} successfully completed.`);
});
worker.on("failed", (job, err) => {
    console.log(`❌ Job ${job === null || job === void 0 ? void 0 : job.id} failed:`, err.message);
});
exports.default = worker;
