// CoCheck's macOS page drawer. Draws one page of one PDF with macOS PDFKit; no network, writes nothing but the one PNG it is asked for.
//
//   pdfpages <file.pdf> --png <n> <out.png>   writes page n (1-based) as a PNG on white
//   pdfpages <file.pdf> --sizes               prints each page's drawn size, one "index width height" line per page
//
// Pixels are at SCALE x the page's displayed size in points, crop box and rotation applied. This is the Mac's drawing backend and nothing else:
// page count, sizes, text, the paragraph finder and the page crop come from the pdf.js reader on every OS (public-kit/helpers/pdf-text.mjs).
// Exit code 2 = bad arguments or cannot open the file, 3 = bad page, 4 = cannot write.
import AppKit
import Foundation
import PDFKit

let SCALE: CGFloat = 2

func fail(_ code: Int32, _ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments
let usage = "usage: pdfpages <file.pdf> --png <n> <out.png> | pdfpages <file.pdf> --sizes"
guard (args.count == 5 && args[2] == "--png") || (args.count == 3 && args[2] == "--sizes") else { fail(2, usage) }
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[1])), !doc.isLocked else { fail(2, "cannot open (damaged or locked)") }

/// The size a page is drawn at, in pixels: its displayed size in points (crop box, rotated) at SCALE.
func drawnSize(_ page: PDFPage) -> (Int, Int) {
    let box = page.bounds(for: .cropBox)
    let rot = ((page.rotation % 360) + 360) % 360
    let swap = rot == 90 || rot == 270
    return (Int(((swap ? box.height : box.width) * SCALE).rounded()), Int(((swap ? box.width : box.height) * SCALE).rounded()))
}

//   pdfpages <file.pdf> --sizes   one line per page, "index width height": the size --png draws it at (so a reader's pages can be checked against the pictures)
if args[2] == "--sizes" {
    var out = ""
    for i in 0..<doc.pageCount { guard let p = doc.page(at: i) else { fail(3, "no such page") }; let (w, h) = drawnSize(p); out += "\(i + 1) \(w) \(h)\n" }
    FileHandle.standardOutput.write(out.data(using: .utf8)!)
    exit(0)
}

guard let n = Int(args[3]), n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1) else { fail(3, "no such page") }
let (pw, ph) = drawnSize(page)

guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let ctx = NSGraphicsContext(bitmapImageRep: rep) else { fail(4, "cannot make bitmap") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: pw, height: ph).fill()
page.thumbnail(of: NSSize(width: pw, height: ph), for: .cropBox).draw(in: NSRect(x: 0, y: 0, width: pw, height: ph))
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { fail(4, "cannot encode png") }
do { try png.write(to: URL(fileURLWithPath: args[4])) } catch { fail(4, "cannot write") }
