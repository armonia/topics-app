// La stessa app Topics dentro una WKWebView vera: il confronto onesto.
import Foundation
import WebKit
import AppKit
func phys(_ pid: pid_t) -> Double {
    var i = rusage_info_current()
    let r = withUnsafeMutablePointer(to: &i) { $0.withMemoryRebound(to: Optional<rusage_info_t>.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_CURRENT, $0) } }
    return r == 0 ? Double(i.ri_phys_footprint)/1048576 : -1
}
func sh(_ c: String) -> String {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = ["-c", c]
    let pipe = Pipe(); p.standardOutput = pipe; try? p.run(); p.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}
func wkProcs() -> [Int32: Double] {
    var m = [Int32: Double]()
    for l in sh("ps -Ao pid=,rss=,comm= | grep -i 'com.apple.WebKit' || true").split(separator: "\n") {
        let f = l.split(separator: " ", omittingEmptySubsequences: true)
        if f.count >= 2, let pid = Int32(f[0]), let r = Double(f[1]) { m[pid] = r/1024 }
    }
    return m
}
let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
let me = ProcessInfo.processInfo.processIdentifier
let base = phys(me), baseProcs = wkProcs()
let cfg = WKWebViewConfiguration()
let v = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: cfg)
v.load(URLRequest(url: URL(string: "http://127.0.0.1:4900/")!))
DispatchQueue.main.asyncAfter(deadline: .now() + 14) {
    let now = wkProcs()
    var ours = 0.0
    for (pid, mb) in now where baseProcs[pid] == nil { ours += mb }
    let total = (phys(me) - base) + ours
    v.evaluateJavaScript("document.querySelectorAll('*').length") { r, _ in
        print("wkwebview, app Topics: \(String(format: "%.0f", total)) MB — nodi DOM: \(r ?? "?")")
        exit(0)
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { print("timeout"); exit(1) }
app.run()
