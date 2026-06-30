/**
 * QR code login flow for WeChat iLink Bot.
 */
import readline from "node:readline";
import { apiPostFetch, apiGetFetch } from "../api/client.ts";
import { BOT_TYPE, ILINK_BASE_URL } from "../config.ts";
import { saveAuth, type AuthData } from "./store.ts";

const QR_POLL_TIMEOUT_MS = 35_000;

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

async function displayQRCode(qrcodeUrl: string): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
    console.log(`\n如果二维码无法显示，请访问：${qrcodeUrl}\n`);
  } catch {
    console.log(`\n请访问以下链接扫码：${qrcodeUrl}\n`);
  }
}

function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function fetchQRCode(apiBaseUrl: string): Promise<QRCodeResponse> {
  const raw = await apiPostFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    body: JSON.stringify({ local_token_list: [] }),
    label: "fetchQRCode",
    timeoutMs: 15_000,
  });
  return JSON.parse(raw) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string, verifyCode?: string): Promise<StatusResponse> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const raw = await apiGetFetch({ baseUrl: apiBaseUrl, endpoint, timeoutMs: QR_POLL_TIMEOUT_MS, label: "pollQRStatus" });
    if (!raw) return { status: "wait" };
    return JSON.parse(raw) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    return { status: "wait" };
  }
}

export interface LoginResult {
  success: boolean;
  message: string;
  auth?: AuthData;
}

export async function loginWithQR(apiBaseUrl: string = ILINK_BASE_URL): Promise<LoginResult> {
  let qrResponse: QRCodeResponse;
  try {
    qrResponse = await fetchQRCode(apiBaseUrl);
  } catch (err) {
    return { success: false, message: `获取二维码失败: ${String(err)}` };
  }

  console.log(`\n用手机微信扫描以下二维码以连接：\n`);
  await displayQRCode(qrResponse.qrcode_img_content);

  const qrcode = qrResponse.qrcode;
  console.log(`等待扫码...\n`);
  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;
  let pendingVerifyCode: string | undefined;
  let currentBaseUrl = apiBaseUrl;

  while (Date.now() < deadline) {
    const statusResponse = await pollQRStatus(currentBaseUrl, qrcode, pendingVerifyCode);

    switch (statusResponse.status) {
      case "wait": process.stdout.write("."); break;
      case "scaned":
        if (pendingVerifyCode) { console.log("\n验证码正确"); pendingVerifyCode = undefined; }
        if (!scannedPrinted) { console.log("\n已扫码，正在确认..."); scannedPrinted = true; }
        break;
      case "need_verifycode":
        pendingVerifyCode = await readLine(pendingVerifyCode ? "数字不匹配，请重新输入：" : "请输入手机微信上显示的数字：");
        continue;
      case "expired":
        console.log("\n二维码已过期，正在刷新...");
        try {
          qrResponse = await fetchQRCode(apiBaseUrl);
          console.log(`\n二维码已刷新，请重新扫描：\n`);
          await displayQRCode(qrResponse.qrcode_img_content);
          scannedPrinted = false;
        } catch (err) { return { success: false, message: `刷新二维码失败: ${String(err)}` }; }
        break;
      case "verify_code_blocked":
        console.log("\n多次输入错误，请重新扫码。");
        pendingVerifyCode = undefined;
        try {
          qrResponse = await fetchQRCode(apiBaseUrl);
          console.log(`\n二维码已刷新，请重新扫描：\n`);
          await displayQRCode(qrResponse.qrcode_img_content);
          scannedPrinted = false;
        } catch (err) { return { success: false, message: `刷新二维码失败: ${String(err)}` }; }
        break;
      case "binded_redirect":
        console.log("\n已连接过此 Bot，无需重复连接。");
        return { success: true, message: "已连接过此 Bot" };
      case "scaned_but_redirect":
        if (statusResponse.redirect_host) {
          currentBaseUrl = `https://${statusResponse.redirect_host}`;
        }
        break;
      case "confirmed":
        if (!statusResponse.ilink_bot_id) return { success: false, message: "服务器未返回 Bot ID" };
        const auth: AuthData = {
          botToken: statusResponse.bot_token!,
          ilinkBotId: statusResponse.ilink_bot_id,
          baseUrl: statusResponse.baseurl || apiBaseUrl,
          ilinkUserId: statusResponse.ilink_user_id,
        };
        saveAuth(auth);
        console.log(`\n登录成功！Bot ID: ${auth.ilinkBotId}`);
        return { success: true, message: "登录成功", auth };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { success: false, message: "登录超时，请重试。" };
}
