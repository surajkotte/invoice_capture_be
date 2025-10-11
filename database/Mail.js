import ImapConfig from "../Connections/MailConfig.js";
import Imap from "node-imap";
import { SQLFile } from "./SQLFile.js";
import { simpleParser } from "mailparser";
import pLimit from "p-limit";
import PersistentQueue from "../utils/Queue.js";
const limit = pLimit(3);
let reconnectTimeout;
let imap;
function reconnect() {
  console.log("Reconnecting in 5 seconds...");
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
    console.log("IMAP connected");

    openInbox((err, box) => {
      if (err) throw err;
      console.log(`Inbox opened: ${box.messages.total} messages`);

      imap.search(["UNSEEN"], (err, results) => {
        if (err) throw err;
        if (!results || results.length === 0) {
          console.log("No unread mails found.");
        } else {
          console.log(`Found ${results.length} unread mail(s).`);

          const fetch = imap.fetch(results, {
            bodies: "",
            markSeen: true,
          });

          fetch.on("message", (msg, seqno) => {
            console.log(`Fetching unread message #${seqno}`);
            let emailBuffer = "";

            msg.on("body", (stream, info) => {
              stream.on("data", (chunk) => {
                emailBuffer += chunk.toString("utf8");
              });
            });

            msg.once("end", () => {
              simpleParser(emailBuffer, (err, parsed) => {
                if (err) console.error("Parsing error:", err);
                else {
                  console.log("From:", parsed.from.text);
                  console.log("Subject:", parsed.subject);
                  console.log("Date:", parsed.date);
                  console.log("Body:", parsed.text);

                  if (parsed.attachments.length > 0) {
                    console.log(
                      `Found ${parsed.attachments.length} attachment(s)`
                    );
                    processAttachments(parsed.attachments);
                  } else {
                    console.log("No attachments found.");
                  }
                }
              });
            });
          });

          fetch.once("end", () => {
            console.log("Done fetching unread mails.");
          });
        }
      });
      imap.on("mail", (numNewMsgs) => {
        console.log(`${numNewMsgs} new message(s) received`);

        // Fetch the latest message
        const fetch = imap.seq.fetch(
          box.messages.total + ":" + box.messages.total,
          {
            bodies: "",
            markSeen: true,
          }
        );

        fetch.on("message", (msg, seqno) => {
          console.log(`Fetching message #${seqno}`);
          let emailBuffer = "";

          msg.on("body", (stream, info) => {
            stream.on("data", (chunk) => {
              emailBuffer += chunk.toString("utf8");
            });
          });

          msg.once("end", async () => {
            simpleParser(emailBuffer, async (err, parsed) => {
              if (err) {
                console.error("Parsing error:", err);
              } else {
                console.log("From:", parsed.from.text);
                console.log("Subject:", parsed.subject);
                console.log("Date:", parsed.date);
                console.log("Body:", parsed.text);
                if (parsed.attachments.length > 0) {
                  console.log(
                    `Found ${parsed.attachments.length} attachment(s)`
                  );
                  //processAttachments(parsed?.attachments);
                  await enqueueAttachments(parsed.attachments);
                } else {
                  console.log("No attachments found.");
                }
              }
            });
          });
        });

        fetch.once("error", (err) => {
          console.error("Fetch error:", err);
        });

        fetch.once("end", () => {
          console.log("Done fetching new message");
        });
      });

      console.log("Listening for new mail...");
    });
  });
  imap.once("error", (err) => {
    console.error("IMAP error:", err);
    console.log("Reconnecting in 5 seconds...");
    reconnect();
  });

  imap.once("end", () => {
    console.log("Connection ended");
    reconnect();
  });
  imap.on("close", (hadError) => {
    console.log("Connection closed", hadError ? "with error" : "");
    reconnect();
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
  });
  try {
    imap.connect();
    console.log("connected to mail");
  } catch (error) {
    console.log(error);
  }
};

async function processAttachments(attachments) {
  const validAttachments = attachments.filter(isValidAttachment);
  console.log(`Processing ${validAttachments.length} valid attachment(s)`);

  const uploadTasks = validAttachments.map((attachment, index) =>
    limit(() => processAttachment(attachment, index))
  );

  await Promise.all(uploadTasks);
}
async function uploadWithRetry(payload, filename, retries = 3) {
  try {
    console.log(`Uploading ${filename}...`);
    const response = await SQLFile.mail_upload(payload);
    return { messageType: "S", message: `Uploaded ${filename}` };
  } catch (err) {
    if (retries > 0) {
      console.warn(`Retrying ${filename}, retries left: ${retries}`);
      await new Promise((res) => setTimeout(res, 1000 * (4 - retries)));
      return uploadWithRetry(payload, filename, retries - 1);
    }
    return { messageType: "E", message: `Upload failed for ${err.message}` };
  }
}
async function extractWithRetry(attachment, retries = 3) {
  try {
    console.log(`Extracting ${attachment.filename}...`);
    const payload = await SQLFile.extract_image(
      attachment.filename || "unknown",
      attachment.size || 0,
      attachment.contentType || "unknown",
      attachment.content || Buffer.alloc(0),
      attachment.type || "unknown"
    );
    console.log(payload);
    if (!payload || !payload.payload) {
      throw new Error("Invalid extraction result");
    }
    return payload;
  } catch (err) {
    if (retries > 0) {
      console.warn(
        `Extraction failed for ${attachment.filename}, retries left: ${retries}`
      );
      await new Promise((res) => setTimeout(res, 1000 * (4 - retries)));
      return extractWithRetry(attachment, retries - 1);
    }
    console.error(
      `Extraction ultimately failed for ${attachment.filename}:`,
      err
    );
    return null;
  }
}
async function enqueueAttachments(attachments) {
  const valid = attachments.filter(isValidAttachment);
  console.log(`Queuing ${valid.length} valid attachment(s)...`);

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
    console.log(`Processing ${attachment.filename}...`);
    const payload = await extractWithRetry(attachment, 3);
    if (payload) {
      console.log(`Extraction successful for ${attachment.filename}`);
      const response = await uploadWithRetry(payload, attachment.filename, 3);
      return response;
    } else {
      console.log(`Extraction failed after retries for ${attachment.filename}`);
    }
  } catch (err) {
    console.error(`Error processing ${attachment.filename}:`, err);
  }
}
const attachmentQueue = new PersistentQueue("./attachmentsQueue.json");
createAndConnect();
attachmentQueue.startProcessing(processAttachment, 5000);
