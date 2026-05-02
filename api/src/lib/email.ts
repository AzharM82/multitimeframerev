/**
 * Outbound email via Gmail SMTP_SSL.
 * Reuses GMAIL_USER / GMAIL_APP_PASSWORD env vars from StockAgentHub / Azure Cost Manager.
 */

import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set");
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return transporter;
}

export async function sendHtmlEmail(to: string, subject: string, html: string): Promise<void> {
  const t = getTransporter();
  await t.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject,
    html,
  });
}
