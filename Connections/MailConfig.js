import dotenv from "dotenv";
dotenv.config();
console.log(process.env.EMAIL_HOST);
const ImapConfig = {
  user: process.env.EMAIL_USER,
  password: process.env.EMAIL_PASSWORD,
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  tls: true,
};
export default ImapConfig;
