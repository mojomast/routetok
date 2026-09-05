import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateAddress } from "../../src/net-address.js";

test("private IPv4 ranges classify as private", () => {
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("10.255.255.255"), true);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("127.255.255.255"), true);
  assert.equal(isPrivateAddress("169.254.1.1"), true);
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("172.31.255.255"), true);
  assert.equal(isPrivateAddress("192.168.0.1"), true);
  assert.equal(isPrivateAddress("192.168.255.255"), true);
  assert.equal(isPrivateAddress("100.64.0.1"), true, "CGNAT is private");
  assert.equal(isPrivateAddress("100.127.255.255"), true, "CGNAT is private");
  assert.equal(isPrivateAddress("192.0.0.9"), true);
  assert.equal(isPrivateAddress("0.0.0.0"), true);
  assert.equal(isPrivateAddress("224.0.0.1"), true, "multicast is not reachable infrastructure");
});

test("public IPv4 addresses classify as not private", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "169.253.0.1", "192.167.255.255", "100.63.255.255", "100.128.0.1", "11.0.0.1", "198.51.100.1"]) {
    assert.equal(isPrivateAddress(address), false, `${address} must not classify as private`);
  }
  assert.equal(isPrivateAddress("300.1.1.1"), false, "out-of-range octets are not private");
});

test("IPv6 private and loopback forms classify as private", () => {
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("::"), true);
  assert.equal(isPrivateAddress("fc00::1"), true);
  assert.equal(isPrivateAddress("fd12:3456::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("fe90::1"), true);
  assert.equal(isPrivateAddress("feb0::1"), true);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true, "IPv4-mapped loopback is private");
  assert.equal(isPrivateAddress("::ffff:10.0.0.1"), true, "IPv4-mapped RFC1918 is private");
});

test("public IPv6 addresses classify as not private", () => {
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  assert.equal(isPrivateAddress("2001:db8::1"), false);
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false, "IPv4-mapped public is not private");
  assert.equal(isPrivateAddress("f800::1"), false, "fc/fd prefix boundaries hold");
  assert.equal(isPrivateAddress("garbage"), false);
});
