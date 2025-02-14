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
const express_1 = __importDefault(require("express"));
const example_queue_1 = __importDefault(require("./queues/example-queue"));
const app = (0, express_1.default)();
const PORT = 5000;
app.use(express_1.default.json());
app.get("/", (req, res) => {
    res.status(200).json({ message: "Welcome to navx-queue" });
});
app.get("/add-job", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const date = new Date();
    yield example_queue_1.default.add("testJob", { date });
    res.status(200).json({ message: "Task added to queue" });
}));
app.listen(PORT, () => {
    console.log(`Server is listening on http://localhost:${PORT}`);
});
