import { describe, it, expect } from "vitest";
import { classifyIsp } from "./isp";

describe("classifyIsp: ASN 命中", () => {
  it.each([
    [4134, "ct"], // CHINANET-BACKBONE 电信骨干
    [4809, "ct"], // CN2
    [4812, "ct"], // 上海电信
    [23724, "ct"], // 北京电信 IDC
    [63595, "ct"], // LINKCHINANET 园区网络
    [150203, "ct"], // 电信印尼
    [37963, "ct"], // 阿里云（写死）
    [45102, "ct"], // 阿里云（写死）
    [45090, "ct"], // 腾讯云（写死）
    [9390, "ct"], // 腾讯（写死）
    [4837, "cu"], // CHINA169 联通骨干
    [9929, "cu"], // CUII
    [4808, "cu"], // 北京联通
    [132281, "cu"], // 联通新加坡
    [134821, "cu"], // 联通澳洲
    [9808, "cm"], // 移动骨干
    [56040, "cm"], // 广东移动
    [58453, "cm"], // CMI 香港
    [24311, "cm"], // CNGI-CMNETV6
    [9394, "cm"], // 原铁通 CTTNET
  ])("ASN %s → %s", (asn, expected) => {
    expect(classifyIsp(asn, null)).toBe(expected);
  });

  it.each([
    [17504, "日本 NRI Netcom（撞名剔除）"],
    [134009, "印度 NETCOM（撞名剔除）"],
    [138996, "马来 Uni Comms（撞名剔除）"],
    [133878, "新西兰 Unicom（撞名剔除）"],
    [63616, "北京 GlobalUnicom（撞名剔除）"],
    [53792, "加拿大 CMCC（撞名剔除）"],
    [22034, "美国 McMaster（CMNET 子串误伤）"],
    [402205, "阿里云美国（海外，不写死）"],
  ])("ASN %s → overseas（%s）", (asn, _desc) => {
    expect(classifyIsp(asn, null)).toBe("overseas");
  });

  it("未收录 ASN（海外 Google）→ overseas", () => {
    expect(classifyIsp(15169, null)).toBe("overseas");
  });

  it("无 asn 无 org → overseas", () => {
    expect(classifyIsp(null, null)).toBe("overseas");
    expect(classifyIsp(undefined, undefined)).toBe("overseas");
  });
});

describe("classifyIsp: 组织名二次兜底", () => {
  it.each([
    ["CHINANET Guangdong province network", "ct"],
    ["China Telecom Global (Indonesia)", "ct"],
    ["CHINA169-Backbone", "cu"],
    ["China Unicom (Singapore) Operations", "cu"],
    ["CHINAMOBILE-CN", "cm"],
    ["China Mobile Communications Corporation IPv6 network", "cm"],
    ["China TieTong Telecommunications Corporation", "cm"],
  ])("org '%s' → %s", (org, expected) => {
    expect(classifyIsp(null, org)).toBe(expected);
  });

  it.each([
    ["ALIBABA CLOUD US LLC", "海外阿里云不写死"],
    ["Canadian Museum of Civilization", "CMCC 撞名不兜底"],
    ["Unicom New Zealand Limited", "裸 UNICOM 撞名不兜底"],
    ["Netcom Enterprises Pvt Ltd", "NETCOM 撞名不兜底"],
  ])("org '%s' → overseas（%s）", (org, _desc) => {
    expect(classifyIsp(null, org)).toBe("overseas");
  });

  it("asn 优先于 org（表内 ASN 不落入 org 兜底）", () => {
    expect(classifyIsp(4837, "ALIBABA CLOUD US LLC")).toBe("cu");
    expect(classifyIsp(17504, "CHINANET Guangdong province network")).toBe("ct");
  });
});
