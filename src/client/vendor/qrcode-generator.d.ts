/**
 * Types for the vendored QR encoder (qrcode-generator 2.0.4 by Kazuhiko Arase, MIT; see
 * THIRD_PARTY_NOTICES.md). Only what src/client/qr.tsx uses.
 */
export interface QRCode {
  addData(data: string, mode?: 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

export declare const qrcode: (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H') => QRCode;
export default qrcode;
