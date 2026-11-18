/**
 * The Swift helper the Apple adapter compiles on first use.
 *
 * It lives as a string, not as a file next to the code, because the server ships
 * as one compiled binary where no loose source file survives. The adapter writes
 * it to the cache folder and runs `swiftc` on it; nothing here runs unless a Mac
 * with macOS 26 and the Swift compiler asks for it.
 *
 * Protocol: one JSON object per line on stdin, one per line on stdout, answered
 * in order. Operations: ping, detect, status, translate.
 */
export const APPLE_HELPER_SOURCE = String.raw`import Foundation
import NaturalLanguage
import Translation

@available(macOS 26.0, *)
// Translation sessions are kept warm per language pair: the first sentence pays
// the model load, the next ones cost a few hundred milliseconds.
final class Engine {
    var sessions: [String: TranslationSession] = [:]
    let availability = LanguageAvailability()

    func status(from: String, to: String) async -> String {
        let s = await availability.status(from: Locale.Language(identifier: from), to: Locale.Language(identifier: to))
        switch s {
        case .installed: return "installed"
        case .supported: return "supported"
        default: return "unsupported"
        }
    }

    func translate(_ text: String, from: String, to: String) async throws -> String {
        let key = "\(from)>\(to)"
        let session: TranslationSession
        if let s = sessions[key] { session = s } else {
            session = TranslationSession(installedSource: Locale.Language(identifier: from), target: Locale.Language(identifier: to))
            sessions[key] = session
        }
        return try await session.translate(text).targetText
    }
}

func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
}

func detect(_ text: String) -> (String, Double) {
    let r = NLLanguageRecognizer()
    r.processString(text)
    guard let dominant = r.dominantLanguage else { return ("und", 0) }
    let p = r.languageHypotheses(withMaximum: 1)[dominant] ?? 0
    return (dominant.rawValue, p)
}

if #available(macOS 26.0, *) {
    let engine = Engine()
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        let id = req["id"] ?? NSNull()
        let op = req["op"] as? String ?? ""
        switch op {
        case "ping": emit(["id": id, "ok": true])
        case "detect":
            let (l, c) = detect(req["text"] as? String ?? "")
            emit(["id": id, "lang": l, "confidence": c])
        case "status":
            emit(["id": id, "status": await engine.status(from: req["from"] as? String ?? "", to: req["to"] as? String ?? "")])
        case "translate":
            do {
                let out = try await engine.translate(req["text"] as? String ?? "", from: req["from"] as? String ?? "", to: req["to"] as? String ?? "")
                emit(["id": id, "text": out])
            } catch { emit(["id": id, "error": "\(error)"]) }
        default: emit(["id": id, "error": "unknown op"])
        }
    }
} else {
    emit(["id": NSNull(), "error": "needs macOS 26"])
}
`;
