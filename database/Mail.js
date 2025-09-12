import imap from "../Connections/MailConfig.js";
import { SQLFile } from "./SQLFile.js";
import { simpleParser } from "mailparser";
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

        msg.once("end", () => {
          simpleParser(emailBuffer, (err, parsed) => {
            if (err) {
              console.error("Parsing error:", err);
            } else {
              console.log("From:", parsed.from.text);
              console.log("Subject:", parsed.subject);
              console.log("Date:", parsed.date);
              console.log("Body:", parsed.text);
              if (parsed.attachments.length > 0) {
                console.log(`Found ${parsed.attachments.length} attachment(s)`);

                parsed.attachments.forEach((attachment, index) => {
                  console.log(attachment);
                  SQLFile.mail_upload(
                    attachment?.filename,
                    attachment?.size,
                    attachment?.contentType,
                    attachment?.content,
                    attachment?.type,
                    ""
                  );
                });
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
});

imap.once("end", () => {
  console.log("Connection ended");
});

try {
  imap.connect();
  console.log("connected to mail");
} catch (error) {
  console.log(error);
}
