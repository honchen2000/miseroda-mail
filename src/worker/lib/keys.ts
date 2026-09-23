/** R2 物件 key 規約 */
export const r2RawKey = (userId: string, messageId: string) => `raw/${userId}/${messageId}.eml`;
export const r2HtmlKey = (userId: string, messageId: string) => `html/${userId}/${messageId}.html`;
export const r2AttKey = (userId: string, messageId: string, attachmentId: string) =>
  `att/${userId}/${messageId}/${attachmentId}`;
export const r2UploadKey = (userId: string, attachmentId: string) => `upload/${userId}/${attachmentId}`;
export const r2CalKey = (userId: string, messageId: string) => `cal/${userId}/${messageId}.ics`;
export const r2ShareKey = (userId: string, shareId: string) => `share/${userId}/${shareId}`;
