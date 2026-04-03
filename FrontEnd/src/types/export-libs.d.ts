declare module 'xlsx' {
  const XLSX: any
  export const utils: any
  export function writeFile(workbook: any, filename: string, options?: any): void
  export default XLSX
}

declare module 'jspdf' {
  export class jsPDF {
    constructor(options?: any)
    [key: string]: any
  }
}

declare module 'jspdf-autotable' {
  const autoTable: (doc: any, options: any) => void
  export default autoTable
}
