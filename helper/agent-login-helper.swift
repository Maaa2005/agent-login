// agent-login の鍵係。キーチェーンの読み書きと、本人の承認（指紋またはMacのパスワード）だけを行う。
// 値を読み出すのは get だけで、必ず本人の承認を先に通す。
//   info <site>                          保存先の住所と ID（パスワードは出さない）
//   list                                 登録済みの名前と住所
//   add <site>                           標準入力の JSON {"origin","user","password"} を保存
//   remove <site>
//   get <site> <origin> <reason>         呼び出し元が agent-login のサーバーで、origin が登録と一致し、
//                                        本人が承認したときだけ JSON を標準出力へ
//   can-auth                             この Mac で承認の画面を出せるか
//   check-caller                         呼び出し元が get を使える相手か（値は扱わない）
import Foundation
import LocalAuthentication
import Security

let service = "agent-login"

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

func out(_ object: Any) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func baseQuery(_ site: String) -> [String: Any] {
  return [kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: service,
          kSecAttrAccount as String: site]
}

func attributes(_ site: String) -> [String: Any]? {
  var q = baseQuery(site)
  q[kSecReturnAttributes as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  let status = SecItemCopyMatching(q as CFDictionary, &item)
  if status == errSecItemNotFound { return nil }
  guard status == errSecSuccess else { fail(1, "keychain error \(status)") }
  return item as? [String: Any]
}

// 住所は https の完全な origin（scheme://host[:port]）だけを受け付ける。
func validOrigin(_ s: String) -> Bool {
  guard let u = URL(string: s), let scheme = u.scheme, u.host != nil else { return false }
  guard u.path.isEmpty, u.query == nil, u.fragment == nil, u.user == nil else { return false }
  return scheme == "https" || (scheme == "http" && (u.host == "127.0.0.1" || u.host == "localhost"))
}

func validSite(_ s: String) -> Bool {
  return !s.isEmpty && s.count <= 64 && s.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
}

// プロセスの実行ファイル・引数・環境変数を読む（KERN_PROCARGS2）。
func processArgs(_ pid: pid_t) -> (exe: String, argv: [String], env: [String])? {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 0
  guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
  var buf = [UInt8](repeating: 0, count: size)
  guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0 else { return nil }
  let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
  var i = MemoryLayout<Int32>.size
  func next() -> String? {
    guard i < size else { return nil }
    let start = i
    while i < size && buf[i] != 0 { i += 1 }
    let str = String(decoding: buf[start..<i], as: UTF8.self)
    i += 1
    return str
  }
  guard let exe = next() else { return nil }
  while i < size && buf[i] == 0 { i += 1 }
  var argv: [String] = []
  for _ in 0..<argc { guard let a = next() else { return nil }; argv.append(a) }
  var env: [String] = []
  while let e = next(), !e.isEmpty { env.append(e) }
  return (exe, argv, env)
}

// 値を渡してよい呼び出し元か。agent-login のサーバー（node <作ったときの場所>/bin/agent-login.mjs serve）だけを許す。
// node の追加の指定（--require 等・NODE_OPTIONS）で別のコードを読み込ませた呼び出しも断る。
func callerAllowed() -> (ok: Bool, why: String) {
  let ppid = getppid()
  guard let p = processArgs(ppid) else { return (false, "cannot read caller") }
  guard p.argv.count >= 3 else { return (false, "unexpected caller") }
  guard URL(fileURLWithPath: p.exe).lastPathComponent == "node" else { return (false, "caller is not node") }
  guard p.argv[1] == serverScript, p.argv[2] == "serve" else { return (false, "caller is not the agent-login server") }
  // 別のブラウザ（--executable-path）を指すと、入れたパスワードをそのブラウザが受け取れるので断る。
  for a in p.argv.dropFirst(3) where a != "--headless" { return (false, "unexpected server option: \(a)") }
  // node・Playwright・読み込むライブラリを差し替える環境変数も断る。HOME を変えて別の設定を読ませる道も断る。
  for e in p.env {
    let name = String(e.split(separator: "=", maxSplits: 1).first ?? "")
    let value = e.dropFirst(name.count + 1)
    if name.hasPrefix("NODE_") && !value.isEmpty && name != "NODE_ENV" { return (false, "\(name) is set") }
    if name.hasPrefix("PLAYWRIGHT_") || name.hasPrefix("DYLD_") || name.hasPrefix("PWDEBUG") { return (false, "\(name) is set") }
    if name == "HOME", let pw = getpwuid(getuid()), String(value) != String(cString: pw.pointee.pw_dir) { return (false, "HOME differs") }
  }
  return (true, "")
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail(64, "usage: agent-login-helper info|list|add|remove|get|can-auth") }

switch args[1] {
case "can-auth":
  var error: NSError?
  let ok = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
  out(["ok": ok, "error": error?.localizedDescription ?? ""])

case "check-caller":
  let caller = callerAllowed()
  out(["ok": caller.ok, "why": caller.why])

case "info":
  guard args.count == 3, validSite(args[2]) else { fail(64, "usage: info <site>") }
  guard let a = attributes(args[2]) else { fail(3, "not registered") }
  out(["site": args[2], "origin": a[kSecAttrComment as String] as? String ?? "", "user": a[kSecAttrLabel as String] as? String ?? ""])

case "list":
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                          kSecAttrService as String: service,
                          kSecReturnAttributes as String: true,
                          kSecMatchLimit as String: kSecMatchLimitAll]
  var items: CFTypeRef?
  let status = SecItemCopyMatching(q as CFDictionary, &items)
  if status == errSecItemNotFound { out([]); exit(0) }
  guard status == errSecSuccess else { fail(1, "keychain error \(status)") }
  let rows = (items as? [[String: Any]] ?? []).map {
    ["site": $0[kSecAttrAccount as String] as? String ?? "", "origin": $0[kSecAttrComment as String] as? String ?? ""]
  }
  out(rows)

case "add":
  guard args.count == 3, validSite(args[2]) else { fail(64, "usage: add <site>") }
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let obj = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
        let origin = obj["origin"] as? String, let user = obj["user"] as? String,
        let password = obj["password"] as? String, !password.isEmpty else { fail(64, "stdin must be JSON {origin,user,password}") }
  guard validOrigin(origin) else { fail(64, "origin must be https://host[:port]") }
  let secret = try! JSONSerialization.data(withJSONObject: ["v": 1, "origin": origin, "user": user, "password": password])
  SecItemDelete(baseQuery(args[2]) as CFDictionary)
  var q = baseQuery(args[2])
  q[kSecAttrComment as String] = origin
  q[kSecAttrLabel as String] = user
  q[kSecAttrDescription as String] = "agent-login"
  q[kSecValueData as String] = secret
  let status = SecItemAdd(q as CFDictionary, nil)
  guard status == errSecSuccess else { fail(1, "keychain error \(status)") }
  out(["site": args[2], "origin": origin, "saved": true])

case "remove":
  guard args.count == 3, validSite(args[2]) else { fail(64, "usage: remove <site>") }
  let status = SecItemDelete(baseQuery(args[2]) as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { fail(1, "keychain error \(status)") }
  out(["site": args[2], "removed": status == errSecSuccess])

case "get":
  guard args.count == 5, validSite(args[2]) else { fail(64, "usage: get <site> <origin> <reason>") }
  let caller = callerAllowed()
  guard caller.ok else { fail(5, "caller not allowed: \(caller.why)") }
  let site = args[2], origin = args[3]
  let reason = String(args[4].prefix(120))
  guard let a = attributes(site) else { fail(3, "not registered") }
  guard (a[kSecAttrComment as String] as? String) == origin else { fail(4, "origin mismatch") }
  let context = LAContext()
  context.localizedCancelTitle = "拒否"
  let done = DispatchSemaphore(value: 0)
  var approved = false
  context.evaluatePolicy(.deviceOwnerAuthentication,
                         localizedReason: "AI のログインを承認: \(origin)（\(site)）理由: \(reason)") { ok, _ in
    approved = ok
    done.signal()
  }
  done.wait()
  guard approved else { fail(2, "denied") }
  var q = baseQuery(site)
  q[kSecReturnData as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  let status = SecItemCopyMatching(q as CFDictionary, &item)
  guard status == errSecSuccess, let data = item as? Data else { fail(1, "keychain error \(status)") }
  guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        (obj["origin"] as? String) == origin else { fail(4, "origin mismatch") }
  FileHandle.standardOutput.write(data)

default:
  fail(64, "unknown command")
}
