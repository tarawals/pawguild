import { describe, expect, it } from "vitest";
import { csvMoney, toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(toCsv([["Name", "Note"], ["Doe, Jane", 'Said "hi"\nthen left']])).toBe('Name,Note\r\n"Doe, Jane","Said ""hi""\nthen left"\r\n');
  });
  it("neutralizes text that looks like a spreadsheet formula, but not numbers", () => {
    expect(toCsv([["=HYPERLINK(\"x\")", "+1", "@a", -5, csvMoney(-1250)]])).toBe(`"'=HYPERLINK(""x"")",'+1,'@a,-5,-12.50\r\n`);
  });
  it("writes empty cells for missing values and money as plain decimals", () => {
    expect(toCsv([[null, undefined, csvMoney(123456), csvMoney(5)]])).toBe(",,1234.56,0.05\r\n");
  });
});
