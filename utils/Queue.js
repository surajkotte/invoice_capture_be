import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

class PersistentQueue {
  constructor(
    queuePath = "./attachmentsQueue.json",
    processedPath = "./processedQueue.json"
  ) {
    this.queuePath = path.resolve(queuePath);
    this.processedPath = path.resolve(processedPath);
    this.queue = this._loadFromFile(this.queuePath);
    this.processed = this._loadFromFile(this.processedPath);
    this.isProcessing = false;
    this.intervalId = null;
  }

  _loadFromFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return [];
      const data = fs.readFileSync(filePath, "utf8");
      if (!data.trim()) return [];
      return JSON.parse(data);
    } catch (err) {
      console.warn(`Queue file corrupted: ${filePath}. Resetting...`, err);
      return [];
    }
  }

  _saveToFile(filePath, data) {
    clearTimeout(this._saveTimers?.[filePath]);
    this._saveTimers = this._saveTimers || {};

    this._saveTimers[filePath] = setTimeout(() => {
      fs.promises
        .writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
        .catch((err) => console.error("Failed to save file:", filePath, err));
    }, 1000);
  }

  _saveAll() {
    this._saveToFile(this.queuePath, this.queue);
    this._saveToFile(this.processedPath, this.processed);
  }

  enqueue(message) {
    if (!message || typeof message !== "object") {
      throw new Error("Message must be an object");
    }
    const safeMessage = {
      ...message,
      content:
        message.content instanceof Buffer
          ? message.content.toString("base64")
          : message.content || "",
    };

    const msg = {
      id: uuidv4(),
      status: "queued",
      addedAt: new Date().toISOString(),
      ...safeMessage,
    };

    this.queue.push(msg);
    //this._saveToFile(this.queuePath, this.queue);
    console.log(`Enqueued: ${msg.filename}`);
    return msg.id;
  }

  dequeue() {
    const msg = this.queue.shift() || null;
    this._saveToFile(this.queuePath, this.queue);
    return msg;
  }

  peek() {
    return (
      this.queue.find((m) => m.status === "queued" || m.status === "error") ||
      null
    );
  }

  size() {
    return this.queue.filter(
      (m) => m.status === "queued" || m.status === "error"
    ).length;
  }

  isEmpty() {
    return this.size() === 0;
  }

  getAll() {
    return [...this.queue];
  }

  markStatus(id, status, extra = {}) {
    const msg = this.queue.find((m) => m.id === id);
    if (msg) {
      msg.status = status;
      msg.updatedAt = new Date().toISOString();
      Object.assign(msg, extra);
      this._saveToFile(this.queuePath, this.queue);
    }
  }

  moveToProcessed(msg, status = "done", error = null) {
    const index = this.queue.findIndex((m) => m.id === msg.id);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }

    this.processed.push({
      ...msg,
      status,
      finishedAt: new Date().toISOString(),
      error: error ? String(error) : null,
    });

    this._saveAll();
  }

  startProcessing(processFn, intervalMs = 10000) {
    if (this.intervalId) {
      console.log(" Queue processor already running.");
      return;
    }

    console.log(`Queue processor started (interval: ${intervalMs / 1000}s)`);

    this.intervalId = setInterval(async () => {
      if (this.isProcessing || this.isEmpty()) {
        return;
      }
      this.isProcessing = true;

      try {
        const msg = this.peek();
        console.log(`Queue size: ${this.size()}`);
        console.log(`Next item: ${msg?.filename || "None"}`);
        if (!msg) return;

        this.markStatus(msg.id, "processing");
        console.log(`🔧 Processing: ${msg.filename}`);

        const contentBuffer =
          typeof msg.content === "string"
            ? Buffer.from(msg.content, "base64")
            : msg.content || Buffer.alloc(0);

        const respone = await processFn({ ...msg, content: contentBuffer });
        if (respone?.messageType === "S") {
          this.moveToProcessed(msg, "done");
        } else {
          this.markStatus(msg.id, "error", {
            error: respone?.message || "Processing failed",
          });
        }
      } catch (err) {
        console.error(" Queue processing error:", err);
      } finally {
        this.isProcessing = false;
      }
    }, intervalMs);
  }

  stopProcessing() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isProcessing = false;
      console.log("Queue processor stopped");
    }
  }
}

export default PersistentQueue;
