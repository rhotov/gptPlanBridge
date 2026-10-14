import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let factor = CGFloat(size) / 1024
    context.cgContext.scaleBy(x: factor, y: factor)
    let background = NSBezierPath(roundedRect: NSRect(x: 84, y: 84, width: 856, height: 856), xRadius: 190, yRadius: 190)
    NSColor(calibratedRed: 0.09, green: 0.39, blue: 0.35, alpha: 1).setFill()
    background.fill()
    NSColor(calibratedRed: 0.97, green: 0.96, blue: 0.91, alpha: 1).setStroke()
    let ring = NSBezierPath()
    ring.lineWidth = 64
    ring.lineCapStyle = .round
    ring.appendArc(withCenter: NSPoint(x: 512, y: 500), radius: 230, startAngle: 132, endAngle: 48, clockwise: false)
    ring.stroke()
    let power = NSBezierPath()
    power.lineWidth = 64
    power.lineCapStyle = .round
    power.move(to: NSPoint(x: 512, y: 530))
    power.line(to: NSPoint(x: 512, y: 754))
    power.stroke()
    NSGraphicsContext.restoreGraphicsState()
    let data = bitmap.representation(using: .png, properties: [:])!
    try data.write(to: output.appendingPathComponent("\(size).png"))
}
