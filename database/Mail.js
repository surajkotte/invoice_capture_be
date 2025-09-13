import imap from "../Connections/MailConfig.js";
import { SQLFile } from "./SQLFile.js";
import { simpleParser } from "mailparser";
import pLimit from "p-limit";
const limit = pLimit(3);
function openInbox(cb) {
  imap.openBox("INBOX", false, cb);
}

imap.once("ready", () => {
  console.log("IMAP connected");

  openInbox((err, box) => {
    if (err) throw err;
    console.log(`Inbox opened: ${box.messages.total} messages`);

    // Listen for new emails
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
                console.log(`Found ${parsed.attachments.length} attachment(s)`);
                // const validAttachments = attachments.filter(isValidAttachment);
                // console.log(
                //   `Processing ${validAttachments.length} valid attachment(s)`
                // );

                // const uploadTasks = validAttachments.map((attachment, index) =>
                //   limit(() => uploadWithRetry(attachment, index))
                // );

                // await Promise.all(uploadTasks);
                processAttachments(parsed?.attachments);
                // parsed.attachments.forEach((attachment, index) => {
                //   console.log(attachment);
                //   SQLFile.mail_upload(
                //     attachment?.filename,
                //     attachment?.size,
                //     attachment?.contentType,
                //     attachment?.content,
                //     attachment?.type,
                //     ""
                //   );
                // });
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
  setTimeout(() => {
    imap.connect();
  }, 5000);
});

imap.once("end", () => {
  console.log("Connection ended");
});
imap.on("close", (hadError) => {
  console.log("Connection closed", hadError ? "with error" : "");
  setTimeout(() => {
    imap.connect(); // your function to reconnect
  }, 5000);
});
async function processAttachments(attachments) {
  const validAttachments = attachments.filter(isValidAttachment);
  console.log(`Processing ${validAttachments.length} valid attachment(s)`);

  const uploadTasks = validAttachments.map((attachment, index) =>
    limit(() => uploadWithRetry(attachment, index))
  );

  await Promise.all(uploadTasks);
}
async function uploadWithRetry(attachment, index, retries = 3) {
  try {
    console.log(`Uploading ${attachment.filename}...`);
    await SQLFile.mail_upload(
      attachment.filename || "unknown",
      attachment.size || 0,
      attachment.contentType || "unknown",
      attachment.content || Buffer.alloc(0),
      attachment.type || "unknown",
      ""
    );
    console.log(`Uploaded ${attachment.filename}`);
  } catch (err) {
    if (retries > 0) {
      console.warn(`Retrying ${attachment.filename}, retries left: ${retries}`);
      await new Promise((res) => setTimeout(res, 1000 * (4 - retries)));
      return uploadWithRetry(attachment, index, retries - 1);
    }
    console.error(`Failed to upload ${attachment.filename}:`, err);
  }
}
function isValidAttachment(attachment) {
  return attachment.size > 0 && attachment.size < 50 * 1024 * 1024; // max 50 MB
}

try {
  imap.connect();
  console.log("connected to mail");
} catch (error) {
  console.log(error);
}
