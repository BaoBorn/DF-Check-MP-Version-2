const axios = require('axios');
const qs = require('querystring');

async function testScrape() {
    console.log("Testing with raw cookie...");
    try {
        const res = await axios.post(
            "https://www.deadfrontier.com/market_display.php",
            qs.stringify({
                searchname: "nodachi",
                searchtype: "",
                tradezone: 21,
                searchbutton: "Search",
                category: ""
            }),
            {
                timeout: 8000,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": "kl0nv16p1rf99ubmar8so407ub",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            }
        );
        console.log("Raw Cookie Result length:", res.data.length);
        console.log("Includes tradelist?", res.data.includes("tradelist_0_"));
    } catch (e) { console.error("Error 1", e.message); }

    console.log("\nTesting with PHPSESSID= ...");
    try {
        const res2 = await axios.post(
            "https://www.deadfrontier.com/market_display.php",
            qs.stringify({
                searchname: "nodachi",
                searchtype: "",
                tradezone: 21,
                searchbutton: "Search",
                category: ""
            }),
            {
                timeout: 8000,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": "PHPSESSID=kl0nv16p1rf99ubmar8so407ub",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            }
        );
        console.log("PHPSESSID Result length:", res2.data.length);
        console.log("Includes tradelist?", res2.data.includes("tradelist_0_"));
        if (res2.data.includes("tradelist_0_")) console.log("Success with PHPSESSID");
    } catch (e) { console.error("Error 2", e.message); }
}

testScrape();
