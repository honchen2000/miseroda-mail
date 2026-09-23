// F18.2：sanitize 語料回歸用的「典型信件」樣本（無 vitest 依賴，純資料＋一個純函式）。
// 每封都是依該寄件端家族的真實結構手寫（Outlook 的 mso/o:p/條件註解、Gmail 的 gmail_quote、Apple Mail 的
// blockquote type=cite、Mailchimp 的 <style> class 版型、GitHub 的 <pre>、HTML 3.2 的 <font>/<center>…），
// 內容為虛構；aws-verify 則是一封真實信（2026-09-19 收到的 AWS 驗證信，驗證碼與追蹤網址已遮碼）。
// 新增家族：加一筆即可，測試會自動涵蓋。minKeep 是「消毒後可見文字 / 來源可見文字」的下限，預設 0.95。

export interface CorpusFixture {
  name: string;
  html: string;
  /** true = html 欄位其實是純文字，測試會先走 textToHtml（與 consumer 對純文字信的路徑相同） */
  text?: boolean;
  minKeep?: number;
  mustContain?: string[];
  mustNotContain?: string[];
  mustMatch?: RegExp[];
}

/** 可見文字：兩邊（來源／輸出）用同一把尺量，比值才有意義。實體統一計 1 字。 */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|title|head|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;|&\w+;/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

export const CORPUS: CorpusFixture[] = [
  {
    name: 'outlook-desktop（Word 引擎：mso 樣式、o:p、條件註解、<style><!-- --></style>）',
    html: `<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=Generator content="Microsoft Word 15 (filtered medium)"><!--[if !mso]><style>v\\:* {behavior:url(#default#VML);} o\\:* {behavior:url(#default#VML);}</style><![endif]--><style><!-- p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0cm;font-size:11.0pt;font-family:"Calibri",sans-serif;mso-fareast-language:ZH-TW;} a:link {color:#0563C1;text-decoration:underline;} --></style></head><body lang=ZH-TW link="#0563C1" vlink="#954F72" style='word-wrap:break-word'><div class=WordSection1><p class=MsoNormal>陳先生您好，<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal>附件是本週的<b>報價單</b>，請於 9/25 前回覆。<o:p></o:p></p><p class=MsoNormal><span style='mso-fareast-language:EN-US'>如有問題請隨時聯絡。</span><o:p></o:p></p><table class=MsoNormalTable border=0 cellspacing=0 cellpadding=0><tr><td style='padding:0cm 5.4pt'><p class=MsoNormal><b>王小明</b> | 業務經理<br>ACME 股份有限公司<br>Tel: 02-1234-5678</p></td></tr></table></div></body></html>`,
    mustContain: ['報價單', '王小明', '<b>', 'ACME 股份有限公司'],
    mustNotContain: ['mso-fareast-language', 'behavior:url'],
  },
  {
    name: 'gmail-reply（gmail_quote 引文、gmail_signature、mailto 連結）',
    html: `<div dir="ltr">好的，週三下午三點可以。<div><br></div><div>另外請把上次的簡報一併帶來。<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">林美玲<br>Product Manager · <a href="https://example.com" target="_blank">example.com</a></div></div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">陳大文 &lt;<a href="mailto:chen@example.com">chen@example.com</a>&gt; 於 2026年9月19日 週五 下午2:10寫道：<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">請問週三下午方便開會嗎？<div>地點在 3F 會議室。</div></div></blockquote></div></div>`,
    mustContain: ['<blockquote', '林美玲', '3F 會議室', 'href="https://example.com"'],
    mustMatch: [/border-left:\s*1px solid rgb\(204,\s*204,\s*204\)/],
  },
  {
    name: 'apple-mail（dir=auto、blockquote type=cite、emoji）',
    html: `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body style="overflow-wrap: break-word; -webkit-nbsp-mode: space; line-break: after-white-space;"><div dir="auto">收到，謝謝！</div><div dir="auto"><br></div><div dir="auto">我會在週末前把照片整理好寄給你 📷</div><div dir="auto"><br><blockquote type="cite"><div>2026年9月19日 下午8:30，Hon &lt;hon@miseroda.com&gt; 寫道：</div><br class="Apple-interchange-newline"><div><div dir="auto">上次旅行的照片可以傳給我嗎？</div></div></blockquote></div><br><div dir="auto">Sent from my iPhone</div></body></html>`,
    mustContain: ['dir="auto"', '<blockquote', '📷', 'Sent from my iPhone'],
  },
  {
    name: 'mailchimp-newsletter（<style> class 版型＋@media、preheader、表格排版、圖片）',
    html: `<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="UTF-8"><title>九月電子報</title><style type="text/css">body,#bodyTable{background-color:#FAFAFA;margin:0;padding:0}.mcnTextContent{color:#202020;font-family:Helvetica;font-size:16px;line-height:150%}.mcnImage{max-width:600px;border:0}h1{color:#202020;font-size:26px;font-weight:bold}@media only screen and (max-width:480px){.mcnTextContent{font-size:18px !important}h1{font-size:22px !important}}</style></head><body><span class="mcnPreviewText" style="display:none;font-size:0px;line-height:0px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;visibility:hidden;mso-hide:all;">本月重點：新品上市與會員優惠</span><center><table align="center" border="0" cellpadding="0" cellspacing="0" height="100%" width="100%" id="bodyTable"><tr><td align="center" valign="top" id="bodyCell"><table border="0" cellpadding="0" cellspacing="0" width="600" class="templateContainer"><tr><td valign="top" class="mcnImageBlock"><img align="center" alt="九月電子報橫幅" src="https://mcusercontent.example.com/banner.png" width="600" class="mcnImage"></td></tr><tr><td valign="top" class="mcnTextBlock"><table class="mcnTextContentContainer" width="100%"><tr><td valign="top" class="mcnTextContent" style="padding:9px 18px;"><h1>新品上市</h1><p>這個月我們推出了三款新口味，會員享 <strong>85 折</strong>優惠。</p><p>優惠至 9 月 30 日止，<a href="https://shop.example.com/new?utm_source=mc" style="color:#007C89;font-weight:normal;text-decoration:underline;">立即選購</a>。</p></td></tr></table></td></tr><tr><td class="mcnTextContent" style="font-size:12px;color:#656565;text-align:center;">您收到此信是因為您訂閱了我們的電子報。<br><a href="https://example.us1.list-manage.com/unsubscribe?u=abc">取消訂閱</a></td></tr></table></td></tr></table></center></body></html>`,
    mustContain: ['font-size:16px', '85 折', 'data-blocked-src="https://mcusercontent.example.com/banner.png"', '取消訂閱', '<h1'],
    mustNotContain: ['<style', 'mso-hide'], // <title> 在白名單內（ALLOWED_TAGS 尾端），iframe 內不顯示、保留無害
  },
  {
    name: 'github-notification（role=presentation 表格、<pre>/<code>、深連結）',
    html: `<p><b>@alice</b> commented on <a href="https://github.com/miseroda/mail/pull/42">#42 fix: blank body race</a>:</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:12px;border:1px solid #d0d7de;border-radius:6px;"><p>LGTM，但 <code>enforceExpandLimit</code> 的排序可以再簡化：</p><pre style="background:#f6f8fa;padding:8px;font-family:monospace;">const expanded = ws.filter(w =&gt; !w.minimized);\nif (expanded.length &lt;= max) return ws;</pre><p>另外 <a href="https://github.com/miseroda/mail/blob/main/src/app/composerWins.ts#L14">這一行</a> 有個 typo。</p></td></tr></table><p style="font-size:small;color:#666;">— Reply to this email directly, <a href="https://github.com/miseroda/mail/pull/42#issuecomment-1">view it on GitHub</a>, or <a href="https://github.com/notifications/unsubscribe-auth/XYZ">unsubscribe</a>.<br>You are receiving this because you were mentioned.</p>`,
    mustContain: ['<pre', '<code', 'enforceExpandLimit', '&lt;= max', 'href="https://github.com/miseroda/mail/pull/42"'],
  },
  {
    name: 'legacy-html32（bgcolor、<font>、<center>、未加引號的屬性）',
    html: `<html><body bgcolor="#FFFFFF" text="#000000"><center><font face=Arial size=2 color=#333333><b>系統通知</b></font><br><br><table border=1 cellpadding=3 cellspacing=0 width=500><tr bgcolor=#EEEEEE><td><font face=Arial size=2>項目</font></td><td><font face=Arial size=2>狀態</font></td></tr><tr><td><font size=2>硬碟空間</font></td><td><font size=2 color=red>85% 已使用</font></td></tr><tr><td><font size=2>備份</font></td><td><font size=2 color=green>正常</font></td></tr></table><br><font face=Arial size=1>此為自動發送的信件，請勿直接回覆。</font></center></body></html>`,
    mustContain: ['<font', '<center', '85% 已使用', '請勿直接回覆'],
    mustMatch: [/border="?1"?/],
  },
  {
    name: 'cjk-rtl-mixed（繁中／日文／阿拉伯文 dir=rtl／emoji／mailto）',
    html: `<div lang="zh-Hant"><p>親愛的用戶：您的訂單 <b>#20260919</b> 已出貨。</p><p lang="ja">ご注文ありがとうございます。発送は明日の予定です。</p><p dir="rtl" lang="ar">شكرًا لطلبك، سيتم الشحن غدًا.</p><p>預計送達：9/22（一）🚚📦</p><p>問題請洽 <a href="mailto:support@example.com">support@example.com</a></p></div>`,
    mustContain: ['dir="rtl"', 'ご注文ありがとうございます', 'شكرًا', '🚚📦', 'href="mailto:support@example.com"'],
  },
  {
    name: 'inline-card（LINE／Notion 式重 inline style：漸層保留、box-shadow 濾掉但內容留）',
    html: `<div style="max-width:520px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"><div style="background:linear-gradient(135deg,#06c755,#00b900);border-radius:12px;padding:20px;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.15);"><div style="font-size:18px;font-weight:700;">好友邀請</div><div style="font-size:14px;opacity:.9;margin-top:6px;">小華 想加你為好友</div></div><div style="padding:16px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;"><p style="margin:0 0 12px;">點下方按鈕接受邀請，或在 App 內處理。</p><a href="https://line.example.com/accept?t=abc" style="display:inline-block;background:#06c755;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;">接受</a></div><p style="font-size:12px;color:#999;margin-top:16px;">如果你不認識這位使用者，請忽略此信。</p></div>`,
    mustContain: ['linear-gradient(135deg', 'border-radius:12px', '接受', 'href="https://line.example.com/accept?t=abc"'],
    mustNotContain: ['box-shadow'],
  },
  {
    name: 'image-only（純圖片行銷信：可見文字幾乎為零，斷言改看圖片與 alt 全數存活）',
    html: `<div style="text-align:center"><a href="https://shop.example.com/sale"><img src="https://cdn.example.com/hero.jpg" width="600" height="400" alt="秋季特賣 全館 7 折起"></a><br><img src="https://cdn.example.com/row1.jpg" width="600" alt="精選商品第一列"><br><img src="https://cdn.example.com/row2.jpg" width="600" alt="精選商品第二列"><br><a href="https://shop.example.com/unsub"><img src="https://cdn.example.com/footer.png" width="600" alt="取消訂閱"></a></div>`,
    minKeep: 0,
    mustContain: ['data-blocked-src="https://cdn.example.com/hero.jpg"', 'alt="秋季特賣 全館 7 折起"', 'alt="取消訂閱"', 'width="600"'],
    mustMatch: [/(data-blocked-src="[^"]+"[\s\S]*?){4}/],
  },
  {
    name: 'entities（HTML 實體：&lt;script&gt; 必須留在文字層、不得被解成標籤）',
    html: `<p>價格：NT$1,299 &nbsp;&nbsp; 折扣碼：<code>&lt;SAVE20&gt;</code></p><p>&copy; 2026 Example Co. &mdash; All rights reserved. &ldquo;Quality&rdquo; isn&#8217;t optional.</p><p>公式：a &lt; b &amp;&amp; b &gt; c</p><p>測試字串：&lt;script&gt;alert(1)&lt;/script&gt; 只是文字</p>`,
    mustContain: ['&lt;SAVE20&gt;', '&amp;&amp;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    mustNotContain: ['<SAVE20>', '<script>'],
  },
  {
    name: 'plaintext（純文字信 → textToHtml → sanitize，與 consumer 相同路徑）',
    text: true,
    html: `Hon 你好，\n\n這是純文字信件。沒有 HTML。\n\n重點：\n- 週五交報告\n- 記得帶識別證\n\n網址：https://example.com/docs <-- 這不是連結標籤\n\n謝謝`,
    mustContain: ['<p>', '<br>', '週五交報告', '&lt;-- 這不是連結標籤'],
  },
  {
    name: 'aws-verify（真實信：AWS 驗證碼信，含 <style>、Outlook 條件註解、<xml>、o: 標籤；已遮碼）',
    html: "<!DOCTYPE html>\n<html lang=\"en\" xmlns=\"http://www.w3.org/000000/xhtml\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width\">\n  <meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\n  <meta name=\"x-apple-disable-message-reformatting\">\n  <title>Verify your email address</title>\n  <style>\n      html,\n      body {\n          margin: 0 auto !important;\n          padding: 0 !important;\n          height: 100% !important;\n          width: 100% !important;\n          font-family: \"Amazon Ember\", \"Helvetica Neue\", Roboto, Arial, sans-serif;\n      }\n      * {\n          -ms-text-size-adjust: 100%;\n          -webkit-text-size-adjust: 100%;\n      }\n      div[style*=\"margin: 16px 0\"] {\n          margin: 0 !important;\n      }\n      table,\n      td {\n          mso-table-lspace: 0pt !important;\n          mso-table-rspace: 0pt !important;\n      }\n      table {\n          border-spacing: 0 !important;\n          border-collapse: collapse !important;\n          table-layout: fixed !important;\n          margin: 0 auto !important;\n      }\n      table table table {\n          table-layout: auto;\n      }\n      img {\n          -ms-interpolation-mode:bicubic;\n      }\n      *[x-apple-data-detectors],  /* iOS */\n      .x-gmail-data-detectors,    /* Gmail */\n      .x-gmail-data-detectors *,\n      .aBn {\n          border-bottom: 0 !important;\n          cursor: default !important;\n          color: inherit !important;\n          text-decoration: none !important;\n          font-size: inherit !important;\n          font-family: inherit !important;\n          font-weight: inherit !important;\n          line-height: inherit !important;\n      }\n      /* iPhone 4, 4S, 5, 5S, 5C, and 5SE */\n      @media only screen and (min-device-width: 320px) and (max-device-width: 374px) {\n          .email-container {\n              min-width: 320px !important;\n          }\n      }\n      /* iPhone 6, 6S, 7, 8, and X */\n      @media only screen and (min-device-width: 375px) and (max-device-width: 413px) {\n          .email-container {\n              min-width: 375px !important;\n          }\n      }\n      /* iPhone 6+, 7+, and 8+ */\n      @media only screen and (min-device-width: 414px) {\n          .email-container {\n              min-width: 414px !important;\n          }\n      }\n      /* Media Queries */\n      @media screen and (max-width: 600px) {\n          .email-container {\n              padding-top: 0 !important;\n          }\n\n          #emailBodyContainer {\n              border: 0 !important;\n              border-bottom: 1px solid #DDD !important;\n          }\n\n          body,\n          center {\n              background: #FFF !important;\n          }\n\n          #logoContainer td {\n              padding: 20px 0 20px 0 !important;\n          }\n\n          #footer {\n              background: #F9F9F9 !important;\n          }\n      }\n  </style>\n  <!--[if gte mso 9]>\n  <xml>\n    <o:OfficeDocumentSettings>\n      <o:AllowPNG/>\n      <o:PixelsPerInch>96</o:PixelsPerInch>\n    </o:OfficeDocumentSettings>\n  </xml>\n  <![endif]-->\n</head>\n<body width=\"100%\" style=\"margin: 0; mso-line-height-rule: exactly; background-color: #F0F2F3;\">\n<!--[if mso | IE]>\n<table role=\"presentation\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" bgcolor=\"#F9F9F9\">\n  <tr>\n    <td>\n<![endif]-->\n<div style=\"margin: auto; max-width: 600px; padding-top: 50px;\" class=\"email-container\">\n  <!--[if mso]>\n  <table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" border=\"0\" width=\"600\" align=\"center\">\n    <tr>\n      <td>\n  <![endif]-->\n  <!-- Email Header : BEGIN -->\n  <table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" width=\"100%\" align=\"center\" id=\"logoContainer\" style=\"background: #252F3D; border-radius: 3px 3px 0 0; max-width: 600px;\">\n    <tr>\n      <td style=\"background: #252F3D; border-radius: 3px 3px 0 0; padding: 20px 0 10px 0; text-align: center;\">\n          <img src=\"https://us-east-1.signin.aws/assets/static/img/AWS_logo_RGB_REV.png\"\n               width=\"75\" height=\"45\" alt=\"AWS logo\" border=\"0\" style=\"font-family: sans-serif; font-size: 15px; line-height: 140%; color: #000000;\">\n      </td>\n    </tr>\n  </table>\n  <!-- Email Header : END -->\n  <!-- Email Body : BEGIN -->\n  <table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" width=\"100%\" align=\"center\" id=\"emailBodyContainer\" style=\"border: 0px; border-bottom: 1px solid #D6D6D6; max-width: 600px;\">\n      <tr>\n        <td class=\"module\" style=\"background-color: #FFF; color: #444; font-family: 'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif; font-size: 14px; line-height: 140%; padding: 25px 35px;\">\n        </td>\n      </tr>\n  <tr>\n    <td class=\"module module-otp\" style=\"background-color: #FFF; color: #444; font-family: 'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif; font-size: 14px; line-height: 140%; padding: 25px 35px; padding-top: 0; text-align: center;\">\n      <div class=\"label\" style=\"font-weight: bold; padding-bottom: 15px;\">Verification code</div>\n      <div class=\"code\" style=\"color: #000; font-size: 36px; font-weight: bold; padding-bottom: 15px;\">000000</div>\n      <div class=\"description\" style=\"color: #444; font-size: 10px;\">(This code will expire 10 minutes after it was sent.)</div>\n    </td>\n  </tr>\n  <tr>\n    <td class=\"module module-dark\" style=\"background-color: #FFF; border-top: 1px solid #E0E0E0; color: #777; font-family: 'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif; font-size: 14px; line-height: 140%; padding: 25px 35px;\">\n      <p style=\"margin: 0 0 15px 0; padding: 0 0 0 0;\">Amazon Web Services will never email you and ask you to disclose or verify your password, credit card, or banking account number. If you receive a suspicious email with a link to update your account information, do not click on the link. Instead, report the e-mail to Amazon Web Services for investigation.</p>\n    </td>\n  </tr>\n  </table>\n  <!-- Email Body : END -->\n  <!-- Email Footer : BEGIN -->\n  <table role=\"presentation\" cellSpacing=\"0\" cellPadding=\"0\" width=\"100%\" align=\"center\" id=\"footer\" style=\"max-width: 600px;\">\n    <tr>\n        <td style=\"color: #777; font-family: 'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif; font-size: 12px; line-height: 16px; padding: 20px 30px; text-align: center;\">\n            Amazon Web Services, Inc. is a subsidiary of Amazon.com, Inc. Amazon.com is a registered trademark of Amazon.com, Inc. This message was produced and distributed by Amazon Web Services, Inc., 410 Terry Ave. North, Seattle, WA 000000-000000.\n        </td>\n    </tr>\n  </table>\n  <!-- Email Footer : END -->\n  <!--[if mso]>\n  </td>\n  </tr>\n  </table>\n  <![endif]-->\n</div>\n<!--[if mso | IE]>\n</td>\n</tr>\n</table>\n<![endif]-->\n<img alt=\"\" src=\"https://bjdxkhre.r.us-east-1.awstrack.me/REDACTED\" style=\"display: none; width: 1px; height: 1px;\">\n</body>\n</html>\n",
    mustContain: ['Verification code', '000000', 'data-blocked-src="https://us-east-1.signin.aws/assets/static/img/AWS_logo_RGB_REV.png"', 'Amazon Web Services will never email you'],
    mustNotContain: ['<style', '<xml', '<o:', '<meta'],
  },
];
