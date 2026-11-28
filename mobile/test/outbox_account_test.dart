import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:saydaliti_app/app_state.dart';
import 'package:saydaliti_app/data/api.dart';
import 'package:saydaliti_app/data/outbox.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('legacy rows are preserved verbatim in quarantine and never sent by the next account', () async {
    final legacy = jsonEncode([const Pending.insert('pos_sales', {'id': 'old'}).toJson()]);
    SharedPreferences.setMockInitialValues({'saydaliti.outbox': legacy});
    var calls = 0;
    final api = Api(client: MockClient((_) async { calls++; return http.Response('{"data":null}', 200); }))..token = 'session-b';
    final box = Outbox(api);
    await box.open('b');
    await box.send();
    expect(box.length, 0);
    expect(box.legacyCount, 1);
    expect(calls, 0);
    final prefs = await SharedPreferences.getInstance();
    expect(jsonDecode(prefs.getString('saydaliti.outbox.quarantine.v1')!), [legacy]);
    expect(prefs.containsKey('saydaliti.outbox'), false);
    await box.open('a');
    expect(box.legacyCount, 1);
    expect(box.length, 0);
  });

  test('pending and refused rows survive restart and are isolated by account and server', () async {
    final api = Api(client: MockClient((_) async => http.Response('{"error":{"message":"bad value"}}', 400)))..token = 'session-a';
    final box = Outbox(api);
    await box.open('a');
    await box.add([const Pending.insert('catalog_items', {'id': 'denied'})]);
    await box.send();
    await box.add([const Pending.insert('pos_sales', {'id': 'waiting'})]);
    await box.open('b');
    expect(box.items, isEmpty);
    expect(box.refused, isEmpty);
    final restored = Outbox(api);
    await restored.open('a');
    expect(restored.items.single.row['id'], 'waiting');
    expect(restored.refused.single.entry.row['id'], 'denied');
    final otherServer = Outbox(Api(base: 'http://localhost:8787'));
    await otherServer.open('a');
    expect(otherServer.items, isEmpty);
    await restored.dismiss(restored.refused.single);
    await restored.detach();
    await restored.open('a');
    expect(restored.refused, isEmpty);
  });

  test('switching accounts waits for the in-flight request and leaves the remaining original queue intact', () async {
    final entered = Completer<void>(), finish = Completer<void>();
    final sent = <String>[];
    final api = Api(client: MockClient((req) async {
      sent.add(req.headers['Authorization']!);
      if (sent.length == 1) { entered.complete(); await finish.future; }
      return http.Response('{"data":null}', 200);
    }))..token = 'session-a';
    final box = Outbox(api);
    await box.open('a');
    await box.add([const Pending.insert('pos_sales', {'id': 'a1'}), const Pending.insert('pos_sales', {'id': 'a2'})]);
    final sending = box.send();
    await entered.future;
    final paused = box.detach();
    finish.complete();
    await sending;
    await paused;
    api.token = 'session-b';
    await box.open('b');
    await box.add([const Pending.insert('pos_sales', {'id': 'b1'})]);
    await box.send();
    expect(sent, ['Bearer session-a', 'Bearer session-b']);
    await box.open('a');
    expect(box.items.single.row['id'], 'a2');
  });

  test('an append while a send is in flight is not lost', () async {
    final entered = Completer<void>(), finish = Completer<void>();
    var calls = 0;
    final api = Api(client: MockClient((_) async {
      if (++calls == 1) { entered.complete(); await finish.future; return http.Response('{"data":null}', 200); }
      throw http.ClientException('offline');
    }))..token = 'session-a';
    final box = Outbox(api);
    await box.open('a');
    await box.add([const Pending.insert('pos_sales', {'id': 'a1'})]);
    final sending = box.send();
    await entered.future;
    await box.add([const Pending.insert('pos_sales', {'id': 'a2'})]);
    finish.complete();
    await sending;
    final restarted = Outbox(api);
    await restarted.open('a');
    expect(restarted.items.single.row['id'], 'a2');
  });

  test('corrupt account data is preserved and cannot be overwritten or sent', () async {
    final api = Api()..token = 'session-a';
    final key = 'saydaliti.outbox.v2:${Uri.encodeComponent(api.base)}:a';
    SharedPreferences.setMockInitialValues({key: 'unreadable-original'});
    final box = Outbox(api);
    await box.open('a');
    expect(box.blocked, true);
    await expectLater(box.add([const Pending.insert('pos_sales', {'id': 'new'})]), throwsA(isA<ApiError>()));
    await box.send();
    expect((await SharedPreferences.getInstance()).getString(key), 'unreadable-original');
  });

  test('signing out preserves unsent work for its owner', () async {
    final api = Api(client: MockClient((_) async => throw http.ClientException('offline')))..token = 'session-a';
    final state = AppState(api: api)..userId = 'a';
    await state.write([const Pending.insert('pos_sales', {'id': 'offline-sale'})]);
    await state.signOut();
    expect(state.userId, isEmpty);
    expect(state.pending, 0);
    final restored = Outbox(api);
    await restored.open('b');
    expect(restored.length, 0);
    await restored.open('a');
    expect(restored.items.single.row['id'], 'offline-sale');
  });

  test('expired login clears account state without losing its waiting rows', () async {
    final api = Api(client: MockClient((_) async => http.Response('{"error":{"message":"not signed in"}}', 401)))..token = 'expired-a';
    final state = AppState(api: api)..userId = 'a';
    await state.write([const Pending.insert('pos_sales', {'id': 'waiting-a'})]);
    await state.refresh();
    expect(state.phase, Phase.signedOut);
    expect(state.userId, isEmpty);
    expect(api.token, isNull);
    await expectLater(state.write([const Pending.insert('pos_sales', {'id': 'late'})]), throwsA(isA<ApiError>()));
    final restored = Outbox(api);
    await restored.open('a');
    expect(restored.items.single.row['id'], 'waiting-a');
  });

  test('damaged quarantine preserves both archive and legacy source', () async {
    final legacy = jsonEncode([const Pending.insert('pos_sales', {'id': 'unknown'}).toJson()]);
    SharedPreferences.setMockInitialValues({'saydaliti.outbox': legacy, 'saydaliti.outbox.quarantine.v1': 'damaged'});
    final box = Outbox(Api());
    await box.open('a');
    expect(box.blocked, true);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('saydaliti.outbox'), legacy);
    expect(prefs.getString('saydaliti.outbox.quarantine.v1'), 'damaged');
  });
}
