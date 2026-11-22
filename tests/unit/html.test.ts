import { describe, expect, it } from "vitest";
import { escapeHtml, html, raw } from "../../src/lib/html.js";

describe("html", () => {
  it("escapa < > & \" ' en los valores interpolados", () => {
    const peligro = `<script>alert("x")</script> & 'y'`;
    const resultado = html`<p>${peligro}</p>`.toString();
    expect(resultado).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>",
    );
  });

  it("no escapa el HTML ya marcado como seguro", () => {
    const interno = html`<b>${"a<b"}</b>`;
    expect(html`<div>${interno}</div>`.toString()).toBe("<div><b>a&lt;b</b></div>");
    expect(html`<div>${raw("<i>ok</i>")}</div>`.toString()).toBe("<div><i>ok</i></div>");
  });

  it("une arreglos y omite null, undefined y false", () => {
    const items = ["a", "b<"].map((x) => html`<li>${x}</li>`);
    expect(html`<ul>${items}${null}${undefined}${false}</ul>`.toString()).toBe(
      "<ul><li>a</li><li>b&lt;</li></ul>",
    );
  });

  it("convierte números a texto", () => {
    expect(html`<i>${42}</i>`.toString()).toBe("<i>42</i>");
  });

  it("escapeHtml escapa cadenas sueltas", () => {
    expect(escapeHtml(`"&"`)).toBe("&quot;&amp;&quot;");
  });
});
