import ImapConfig from "../Connections/MailConfig.js";
import Imap from "node-imap";
import { SQLFile } from "./SQLFile.js";
import { simpleParser } from "mailparser";
import fs from "fs";
import path from "path";
import { run } from "../util/sceUtil.js";
import pLimit from "p-limit";
import PersistentQueue from "../utils/Queue.js";
import dbManager from "../Connections/sqlconnection.js";
import logger from "../Connections/Logger.js";
const limit = pLimit(3);
let reconnectTimeout;
let imap;
function reconnect() {
  logger.info("Reconnecting in 5 seconds...");
  clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => {
    createAndConnect();
  }, 5000);
}
function openInbox(cb) {
  imap.openBox("INBOX", false, cb);
}

const createAndConnect = () => {
  imap = new Imap(ImapConfig);

  imap.once("ready", () => {
    logger.info("IMAP connected");

    openInbox((err, box) => {
      if (err) throw err;
      logger.info(`Inbox opened: ${box.messages.total} messages`);

      imap.search(["UNSEEN"], (err, results) => {
        if (err) throw err;
        if (!results || results.length === 0) {
          logger.info("No unread mails found.");
        } else {
          logger.info(`Found ${results.length} unread mail(s).`);

          const fetch = imap.fetch(results, {
            bodies: "",
            markSeen: true,
          });

          fetch.on("message", (msg, seqno) => {
            logger.info(`Fetching unread message #${seqno}`);
            let emailBuffer = "";

            msg.on("body", (stream, info) => {
              stream.on("data", (chunk) => {
                emailBuffer += chunk.toString("utf8");
              });
            });

            msg.once("end", () => {
              simpleParser(emailBuffer, (err, parsed) => {
                if (err) logger.error("Parsing error:", err);
                else {
                  logger.info("From:", parsed.from.text);
                  logger.info("Subject:", parsed.subject);
                  logger.info("Date:", parsed.date);
                  logger.info("Body:", parsed.text);

                  if (parsed.attachments.length > 0) {
                    logger.info(
                      `Found ${parsed.attachments.length} attachment(s)`,
                    );
                    processAttachments(parsed.attachments);
                  } else {
                    logger.info("No attachments found.");
                  }
                }
              });
            });
          });

          fetch.once("end", () => {
            logger.info("Done fetching unread mails.");
          });
        }
      });
      imap.on("mail", (numNewMsgs) => {
        logger.info(`${numNewMsgs} new message(s) received`);

        // Fetch the latest message
        const fetch = imap.seq.fetch(
          box.messages.total + ":" + box.messages.total,
          {
            bodies: "",
            markSeen: true,
          },
        );

        fetch.on("message", (msg, seqno) => {
          logger.info(`Fetching message #${seqno}`);
          let emailBuffer = "";

          msg.on("body", (stream, info) => {
            stream.on("data", (chunk) => {
              emailBuffer += chunk.toString("utf8");
            });
          });

          msg.once("end", async () => {
            simpleParser(emailBuffer, async (err, parsed) => {
              if (err) {
                logger.error("Parsing error:", err);
              } else {
                logger.info("From:", parsed.from.text);
                logger.info("Subject:", parsed.subject);
                logger.info("Date:", parsed.date);
                logger.info("Body:", parsed.text);
                if (parsed.attachments.length > 0) {
                  logger.info(
                    `Found ${parsed.attachments.length} attachment(s)`,
                  );
                  //processAttachments(parsed?.attachments);
                  await enqueueAttachments(parsed.attachments);
                } else {
                  logger.info("No attachments found.");
                }
              }
            });
          });
        });

        fetch.once("error", (err) => {
          logger.error("Fetch error:", err);
        });

        fetch.once("end", () => {
          logger.info("Done fetching new message");
        });
      });

      logger.info("Listening for new mail...");
    });
  });
  imap.once("error", (err) => {
    logger.error("IMAP error:", err);
    logger.info("Reconnecting in 5 seconds...");
    reconnect();
  });

  imap.once("end", () => {
    logger.info("Connection ended");
    reconnect();
  });
  imap.on("close", (hadError) => {
    logger.info("Connection closed", hadError ? "with error" : "");
    reconnect();
  });
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught Exception:", err);
  });
  try {
    imap.connect();
    logger.info("connected to mail");
  } catch (error) {
    logger.error("Error connecting to mail:", error);
  }
};

async function processAttachments(attachments) {
  const validAttachments = attachments.filter(isValidAttachment);
  logger.info(`Processing ${validAttachments.length} valid attachment(s)`);

  const uploadTasks = validAttachments.map((attachment, index) =>
    limit(() => processAttachment(attachment, index)),
  );

  await Promise.all(uploadTasks);
}
async function uploadWithRetry(payload, filename, retries = 3) {
  try {
    logger.info(`Uploading ${filename}...`);
    const response = await SQLFile.mail_upload(payload);
    return { messageType: "S", message: `Uploaded ${filename}` };
  } catch (err) {
    if (retries > 0) {
      logger.warn(`Retrying ${filename}, retries left: ${retries}`);
      await new Promise((res) => setTimeout(res, 1000 * (4 - retries)));
      return uploadWithRetry(payload, filename, retries - 1);
    }
    return { messageType: "E", message: `Upload failed for ${err.message}` };
  }
}
async function extractWithRetry(attachment, layoutHash, retries = 3) {
  try {
    logger.info(`Extracting ${attachment.filename}...`);
    let prompttext = "";
    const promptresponse = await dbManager.query(
      "SELECT * FROM prompt_data WHERE layout_hash = ?",
      [layoutHash],
    );
    logger.info(promptresponse, "prompt response");
    if (promptresponse[0] && promptresponse[0][0]) {
      prompttext = promptresponse[0][0]?.prompts || "";
    }
    logger.info(prompttext, "prompt text");
    const payload = await SQLFile.extract_image(
      attachment.filename || "unknown",
      attachment.size || 0,
      attachment.contentType || "unknown",
      attachment.content || Buffer.alloc(0),
      attachment.type || "unknown",
      prompttext,
    );
    logger.info(payload, "extraction payload");
    if (!payload || !payload.payload) {
      throw new Error("Invalid extraction result");
    }
    return payload;
  } catch (err) {
    if (retries > 0) {
      console.warn(
        `Extraction failed for ${attachment.filename}, retries left: ${retries}`,
      );
      await new Promise((res) => setTimeout(res, 1000 * (4 - retries)));
      return extractWithRetry(attachment, layoutHash, retries - 1);
    }
    console.error(
      `Extraction ultimately failed for ${attachment.filename}:`,
      err,
    );
    return null;
  }
}
async function enqueueAttachments(attachments) {
  const valid = attachments.filter(isValidAttachment);
  logger.info(`Queuing ${valid.length} valid attachment(s)...`);

  for (const att of valid) {
    const contentBuffer =
      typeof att.content === "string"
        ? Buffer.from(att.content, "base64")
        : att.content || Buffer.alloc(0);
    attachmentQueue.enqueue({
      filename: att.filename || "unknown",
      size: att.size || 0,
      contentType: att.contentType || "unknown",
      content: contentBuffer,
      type: att.type || "unknown",
      timeAdded: Date.now(),
    });
  }
}

function isValidAttachment(attachment) {
  return attachment.size > 0 && attachment.size < 50 * 1024 * 1024; // max 50 MB
}
async function processAttachment(attachment) {
  try {
    logger.info(`Processing ${attachment.filename}...`);
    let layoutHash = null;
    const ext = path.extname(attachment.filename).toLowerCase();
    const tempFilename = `mail-${Date.now()}-${attachment.filename}`;
    let tempFilePath = path.resolve("uploads", tempFilename);
    fs.writeFileSync(tempFilePath, attachment.content);
    logger.info(`Generating layout hash for ${attachment.filename}...`);
    const runResult = await run(tempFilename);
    if (runResult && runResult.hash) {
      layoutHash = runResult.hash;
      logger.info(`Hash generated successfully: ${layoutHash}`);
    }
    const payload = await extractWithRetry(attachment, layoutHash, 3);
    if (payload) {
      logger.info(`Extraction successful for ${attachment.filename}`);
      const response = await uploadWithRetry(payload, attachment.filename, 3);
      return response;
    } else {
      logger.info(`Extraction failed after retries for ${attachment.filename}`);
    }
  } catch (err) {
    logger.error(`Error processing ${attachment.filename}:`, err);
  } finally {
    // Clean up temp file if it exists
    // const tempFilePath = path.resolve("uploads", `mail-${Date.now()}-${attachment.filename}`);
    // if (fs.existsSync(tempFilePath)) {
    //   fs.unlinkSync(tempFilePath);
    //   logger.info(`Cleaned up temp file for ${attachment.filename}`);
    // }
  }
}
const attachmentQueue = new PersistentQueue("./attachmentsQueue.json");
createAndConnect();
attachmentQueue.startProcessing(processAttachment, 5000);
