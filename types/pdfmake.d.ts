declare module "pdfmake" {
  interface PdfMakeVirtualFileSystem {
    existsSync(filename: string): boolean;
    readFileSync(filename: string): Buffer;
    writeFileSync(filename: string, content: string | Buffer, options?: unknown): void;
  }

  interface PdfMakeOutputDocument {
    getBuffer(): Promise<Buffer>;
    getBase64(): Promise<string>;
    write(filename: string): Promise<void>;
  }

  interface PdfMakeInstance {
    virtualfs: PdfMakeVirtualFileSystem;
    setFonts(fonts: Record<string, Record<string, string>>): void;
    addFonts(fonts: Record<string, Record<string, string>>): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    createPdf(docDefinition: unknown): PdfMakeOutputDocument;
  }

  const pdfmake: PdfMakeInstance;
  export default pdfmake;
}
