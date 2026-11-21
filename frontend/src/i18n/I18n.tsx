import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { bn, en, type Dict, type Lang, type Tier } from "./dict";

const STORAGE_KEY = "dengue-outlook-lang";

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_BN = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"];
const CITY_BN: Record<string, string> = {
  Chattogram: "চট্টগ্রাম",
  "Dhaka North": "ঢাকা উত্তর",
  "Dhaka South": "ঢাকা দক্ষিণ",
  Gazipur: "গাজীপুর",
  Narayanganj: "নারায়ণগঞ্জ",
};
const PREFIX_BN: Record<string, string> = { DNCC: "ডিএনসিসি", DSCC: "ডিএসসিসি", CCC: "সিসিসি", GCC: "জিসিসি", NCC: "এনসিসি" };

/** Pure helpers, exported for tests. `bnDigits` only swaps digit glyphs; values never change. */
export function bnDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)] ?? d);
}
const dig = (lang: Lang, s: string) => (lang === "bn" ? bnDigits(s) : s);

export function makeFormatters(lang: Lang) {
  const num = (n: number, digits = 1) =>
    dig(lang, n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const int = (n: number) => dig(lang, n.toLocaleString("en-US", { maximumFractionDigits: 0 }));
  const signed = (n: number, digits = 1) => `${n < 0 ? "−" : "+"}${num(Math.abs(n), digits)}`;
  const parts = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return { y: y ?? 1970, m: (m ?? 1) - 1, d: d ?? 1 };
  };
  const month = (m: number) => (lang === "bn" ? MONTHS_BN[m] : MONTHS_EN[m]) ?? "";
  const dayMonth = (iso: string) => {
    const p = parts(iso);
    return `${dig(lang, String(p.d))} ${month(p.m)}`;
  };
  const date = (iso: string) => `${dayMonth(iso)} ${dig(lang, String(parts(iso).y))}`;
  const city = (name: string) => (lang === "bn" ? (CITY_BN[name] ?? name) : name);
  /** "DNCC_Ward_12" -> "DNCC Ward 12" / "ডিএনসিসি ওয়ার্ড ১২" */
  const ward = (id: string) => {
    const m = /^([A-Za-z]+)_Ward_(\d+)$/.exec(id);
    if (!m) return id.replace(/_/g, " ");
    return lang === "bn" ? `${PREFIX_BN[m[1] ?? ""] ?? m[1]} ওয়ার্ড ${bnDigits(m[2] ?? "")}` : `${m[1]} Ward ${m[2]}`;
  };
  const wardNo = (id: string) => dig(lang, /_(\d+)$/.exec(id)?.[1] ?? id);
  return { num, int, signed, dayMonth, date, city, ward, wardNo };
}

export interface I18n extends ReturnType<typeof makeFormatters> {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Dict;
  tier: (t: Tier) => string;
}

const Ctx = createContext<I18n | null>(null);

function readStored(): Lang {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "bn" || v === "en") return v;
  } catch {
    /* storage unavailable: default to English */
  }
  return "en";
}

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? readStored());
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  const t = lang === "bn" ? bn : en;
  useEffect(() => {
    document.documentElement.lang = lang === "bn" ? "bn" : "en";
    document.title = t.htmlTitle;
  }, [lang, t]);
  const value = useMemo<I18n>(
    () => ({ lang, setLang, t, tier: (x) => t.tier[x], ...makeFormatters(lang) }),
    [lang, setLang, t],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n must be used inside I18nProvider");
  return v;
}
