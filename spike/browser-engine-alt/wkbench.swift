// Quanto costa DAVVERO una sessione browser WKWebView su macOS?
// Apre N WKWebView nello stesso processo, su siti reali, e misura:
//  - phys_footprint del processo app (la colonna "Memoria" di Monitoraggio Attività)
//  - RSS di ogni processo WebContent figlio (le webview vere)
// Usage: wkbench <n> <url>
import Foundation
import WebKit
import AppKit

// phys_footprint via proc_pid_rusage — la stessa metrica usata da bench/results
func physFootprintMB(_ pid: pid_t) -> Double {
    var info = rusage_info_current()
    let r = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: Optional<rusage_info_t>.self, capacity: 1) {
            proc_pid_rusage(pid, RUSAGE_INFO_CURRENT, $0)
        }
    }
    guard r == 0 else { return -1 }
    return Double(info.ri_phys_footprint) / 1024.0 / 1024.0
}

func shell(_ cmd: String) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", cmd]
    let pipe = Pipe(); p.standardOutput = pipe
    try? p.run(); p.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

// Mappa pid -> RSS(MB) dei processi WebKit (WebContent/Networking/GPU).
// Solo i pid NUOVI rispetto al baseline sono nostri: gli XPC sono reparented
// a launchd, quindi il ppid non serve a niente e l'attribuzione va fatta per diff.
func webkitProcs() -> [Int32: Double] {
    let out = shell("ps -Ao pid=,rss=,comm= | grep -i 'com.apple.WebKit' || true")
    var m = [Int32: Double]()
    for line in out.split(separator: "\n") {
        let f = line.split(separator: " ", omittingEmptySubsequences: true)
        guard f.count >= 2, let pid = Int32(f[0]), let rss = Double(f[1]) else { continue }
        m[pid] = rss / 1024.0
    }
    return m
}

final class Bench: NSObject, WKNavigationDelegate {
    var views: [WKWebView] = []
    var pending = 0
    var done: (() -> Void)?
    let store: WKWebsiteDataStore
    let pool = WKProcessPool()

    init(shared: Bool) {
        store = shared ? WKWebsiteDataStore.default() : WKWebsiteDataStore.nonPersistent()
    }

    func open(_ url: String, count: Int, shareConfig: Bool, completion: @escaping () -> Void) {
        done = completion
        pending = count
        let sharedCfg = WKWebViewConfiguration()
        sharedCfg.websiteDataStore = store
        sharedCfg.processPool = pool
        for _ in 0..<count {
            let cfg: WKWebViewConfiguration
            if shareConfig { cfg = sharedCfg } else {
                cfg = WKWebViewConfiguration()
                cfg.websiteDataStore = WKWebsiteDataStore.nonPersistent()
            }
            let v = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 720), configuration: cfg)
            v.navigationDelegate = self
            views.append(v)
            v.load(URLRequest(url: URL(string: url)!))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pending -= 1
        if pending <= 0 { done?(); done = nil }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        pending -= 1
        if pending <= 0 { done?(); done = nil }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pending -= 1
        if pending <= 0 { done?(); done = nil }
    }
}

let args = CommandLine.arguments
let n = args.count > 1 ? Int(args[1]) ?? 4 : 4
let url = args.count > 2 ? args[2] : "https://en.wikipedia.org/wiki/Web_browser"
let shareConfig = args.count > 3 ? (args[3] == "shared") : true

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let me = ProcessInfo.processInfo.processIdentifier
let baseApp = physFootprintMB(me)
let baseProcs = webkitProcs()
print("{\"phase\":\"base\",\"appMB\":\(String(format: "%.1f", baseApp)),\"preexistingWebKitProcs\":\(baseProcs.count)}")

let bench = Bench(shared: shareConfig)
bench.open(url, count: n, shareConfig: shareConfig) {
    // lascia assestare
    DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
        let appMB = physFootprintMB(me)
        let nowProcs = webkitProcs()
        // solo i pid comparsi dopo il baseline sono nostri
        var ourMB = 0.0; var ourCount = 0
        var detail: [String] = []
        for (pid, mb) in nowProcs where baseProcs[pid] == nil {
            ourMB += mb; ourCount += 1
            detail.append("\(pid):\(String(format: "%.0f", mb))")
        }
        let deltaApp = appMB - baseApp
        let total = deltaApp + ourMB
        let perSession = total / Double(n)
        print("{\"phase\":\"loaded\",\"n\":\(n),\"mode\":\"\(shareConfig ? "shared" : "isolated")\",\"appMB\":\(String(format: "%.1f", appMB)),\"deltaAppMB\":\(String(format: "%.1f", deltaApp)),\"ourWebKitMB\":\(String(format: "%.1f", ourMB)),\"ourWebKitProcs\":\(ourCount),\"totalMB\":\(String(format: "%.1f", total)),\"perSessionMB\":\(String(format: "%.1f", perSession)),\"procs\":\"\(detail.joined(separator: ","))\"}")
        exit(0)
    }
}

DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
    print("{\"phase\":\"timeout\"}")
    exit(1)
}
app.run()
