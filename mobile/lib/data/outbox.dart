// Writes made on the phone (a count, goods received) wait here until the server has them, so the work
// goes on with no connection. Each row carries its own id, so sending it twice adds it once.
import 'dart:convert';
import 'dart:math' as math;

import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// Now, as the website writes times: UTC with milliseconds ('2026-11-13T04:20:00.123Z').
String nowIso() => DateTime.fromMillisecondsSinceEpoch(DateTime.now().millisecondsSinceEpoch, isUtc: true).toIso8601String();

/// A new random id for a row (a UUID v4, like the website's crypto.randomUUID()).
String newRowId() {
  final r = math.Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// One waiting write: a new row, or a change to a row by its id.
class Pending {
  final String op; // 'insert' or 'update'
  final String table;
  final Map<String, dynamic> row; // the new row, or the changed fields
  final String? id; // the row changed, for 'update'
  const Pending.insert(this.table, this.row)
      : op = 'insert',
        id = null;
  const Pending.update(this.table, String this.id, this.row) : op = 'update';
  const Pending._(this.op, this.table, this.row, this.id);

  Map<String, dynamic> toJson() => {'op': op, 'table': table, 'row': row, if (id != null) 'id': id};
  static Pending fromJson(Map<String, dynamic> j) {
    if (!['insert', 'update'].contains(j['op']) || j['table'] is! String || (j['table'] as String).isEmpty || j['row'] is! Map || (j['op'] == 'update' && j['id'] is! String)) {
      throw const FormatException('invalid pending entry');
    }
    return Pending._(j['op'] as String, j['table'] as String, Map<String, dynamic>.from(j['row'] as Map), j['id'] as String?);
  }
}

/// A write the server refused (not a lost connection): kept out of the queue so it can't block the rest.
class Refused {
  final Pending entry;
  final String why;
  const Refused(this.entry, this.why);
}

class Outbox {
  Outbox(this.api, {this.key = 'saydaliti.outbox'});
  final Api api;
  final String key;
  String? _owner, _storageKey;
  List<Pending> _items = [];
  List<Refused> _refused = [];
  List<Pending> get items => List.unmodifiable(_items);
  List<Refused> get refused => List.unmodifiable(_refused);
  int get length => _items.length;
  int legacyCount = 0;
  bool blocked = false;
  bool _accepting = false;
  Future<void>? _sending;
  Future<void> _writes = Future.value();

  Future<void> _serial(Future<void> Function() action) {
    final result = _writes.then((_) => action());
    _writes = result.catchError((Object _) {});
    return result;
  }

  /// Account changes wait for the current request before changing its credentials.
  /// Pending and refused rows remain on disk under their original account.
  Future<void> detach() async {
    _accepting = false;
    try { await _sending; } catch (_) {}
    await _writes;
    _owner = null;
    _storageKey = null;
    _items = [];
    _refused = [];
    legacyCount = 0;
    blocked = false;
  }

  Future<void> open(String owner) async {
    if (owner.isEmpty) throw const ApiError('not signed in', status: 401);
    if (_owner == owner && _accepting) return;
    await detach();
    final p = await SharedPreferences.getInstance();
    // Preserve unknown legacy data verbatim before removing the old active key.
    // No account is inferred from pharmacy membership, created_by or the next login.
    final archiveKey = '$key.quarantine.v1';
    final old = p.getString(key);
    List<String> archive;
    try {
      archive = p.getString(archiveKey) == null ? [] : List<String>.from(jsonDecode(p.getString(archiveKey)!) as List);
    } catch (_) {
      archive = [];
      blocked = true; // Never overwrite a damaged recovery archive.
    }
    if (old != null && !blocked) {
      if (!archive.contains(old)) archive.add(old);
      final saved = jsonEncode(archive);
      if (!await p.setString(archiveKey, saved)) throw const ApiError('تعذر حفظ العمليات القديمة للمراجعة. حاول تاني.', status: 500);
      await p.reload();
      if (p.getString(archiveKey) != saved) throw const ApiError('تعذر التأكد من حفظ العمليات القديمة.', status: 500);
      if (!await p.remove(key)) throw const ApiError('تعذر عزل العمليات القديمة.', status: 500);
    }
    for (final raw in archive) {
      try { legacyCount += (jsonDecode(raw) as List).length; } catch (_) { legacyCount++; }
    }
    if (blocked) legacyCount++;
    final storageKey = '$key.v2:${Uri.encodeComponent(api.base)}:${Uri.encodeComponent(owner)}';
    final text = p.getString(storageKey);
    if (text != null) {
      try {
        final data = jsonDecode(text) as Map;
        if (data['version'] != 2 || data['owner'] != owner) throw const FormatException('wrong queue owner');
        _items = [for (final row in data['pending'] as List) Pending.fromJson(Map<String, dynamic>.from(row as Map))];
        _refused = [for (final row in data['refused'] as List) Refused(Pending.fromJson(Map<String, dynamic>.from(row['entry'] as Map)), row['why'] as String)];
      } catch (_) {
        // Preserve the bytes for recovery; don't silently replace corrupt data with an empty queue.
        _items = [];
        _refused = [];
        blocked = true;
      }
    }
    _owner = owner;
    _storageKey = storageKey;
    _accepting = true;
  }

  Future<void> _store(String storageKey, List<Pending> next, List<Refused> refused) async {
    final p = await SharedPreferences.getInstance();
    final saved = jsonEncode({'version': 2, 'owner': _owner,
      'pending': [for (final e in next) e.toJson()],
      'refused': [for (final r in refused) {'entry': r.entry.toJson(), 'why': r.why}]});
    if (!await p.setString(storageKey, saved)) throw const ApiError('تعذر حفظ العمليات على الجهاز.', status: 500);
    _items = next;
    _refused = refused;
  }

  Future<void> add(List<Pending> entries) {
    final storageKey = _storageKey;
    return _serial(() async {
      if (!_accepting || storageKey == null || storageKey != _storageKey) throw const ApiError('not signed in', status: 401);
      if (blocked) throw const ApiError('ملف المزامنة محتاج مراجعة. العمليات المحفوظة لم تُحذف.', status: 409);
      // Keep a private copy so a caller cannot change queued fields after they were saved.
      final copies = [for (final e in entries) Pending.fromJson(Map<String, dynamic>.from(jsonDecode(jsonEncode(e.toJson())) as Map))];
      await _store(storageKey, [..._items, ...copies], [..._refused]);
    });
  }

  Future<void> dismiss(Refused entry) => _serial(() async {
    if (!_accepting || blocked || _storageKey == null) return;
    await _store(_storageKey!, [..._items], _refused.where((r) => !identical(r, entry)).toList());
  });

  Future<void> send() => _sending ??= _send().whenComplete(() => _sending = null);

  Future<void> _send() async {
    final storageKey = _storageKey, token = api.token;
    if (!_accepting || blocked || storageKey == null || token == null) return;
    while (_accepting && !blocked && _storageKey == storageKey && api.token == token && _items.isNotEmpty) {
      final e = _items.first;
      Refused? denied;
      try {
        if (e.op == 'insert') {
          await api.insert(e.table, [e.row]);
        } else {
          await api.update(e.table, e.id!, e.row);
        }
      } on ApiError catch (err) {
        if (err.offline || err.status == 401 || err.status == 429 || err.status >= 500) return;
        denied = Refused(e, err.arabic);
      }
      await _serial(() async {
        await _store(storageKey, _items.where((x) => !identical(x, e)).toList(), [..._refused, if (denied != null) denied]);
      });
    }
  }
}
