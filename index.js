const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

const app = express();

app.use(cors());
app.use("/", express.static("public"));
app.use(fileUpload());
app.use(express.json({ limit: '50mb' }));

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Debugging information
console.log("Environment variables:", process.env);
console.log("API_KEY from environment:", process.env.API_KEY);

app.post("/extract-text", (req, res) => {
  if (!req.files || !req.files.pdfFile) {
    return res.status(400).send("No file uploaded");
  }

  pdfParse(req.files.pdfFile.data)
    .then((result) => {
      res.send(result.text);
    })
    .catch((err) => {
      console.error("Error extracting text from PDF:", err);
      res.status(500).send("Error extracting text from PDF");
    });
});

app.post("/analyze-text", async (req, res) => {
  const { extractedText } = req.body;

  if (!extractedText) {
    return res.status(400).json({ error: "No extracted text provided" });
  }

  console.log("Checking API_KEY...");
  const apiKey = process.env.API_KEY;
  console.log("API_KEY value:", apiKey);

  if (!apiKey) {
    console.error("API_KEY is not set in environment variables");
    return res.status(500).json({ error: "Server configuration error: API_KEY not set" });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;

  const prompt = `
    Analyze the following budget text and provide insights:
    
    ${extractedText}
    
    Please provide a detailed analysis in the following JSON format:
    {
      "totalTransactions": "Number of total transactions",
      "totalDebits": "Total amount of debits",
      "totalCredits": "Total amount of credits",
      "majorExpenses": [
        "Expense 1 with amount",
        "Expense 2 with amount",
        "Expense 3 with amount"
      ],
      "majorIncomes": [
        "Income 1 with amount and source",
        "Income 2 with amount and source",
        "Income 3 with amount and source"
      ],
      "suggestions": [
        "Suggestion 1 on where to spend and how much, based on the data",
        "Suggestion 2 on where to spend and how much, based on the data",
        "Suggestion 3 on where to spend and how much, based on the data"
      ]
    }

    Ensure all numerical values are formatted as strings with appropriate currency symbols or units.
    IMPORTANT: Respond ONLY with the JSON object, no additional text or formatting.
    Do not include a 'Net balance' field in the response.
    ALWAYS include EXACTLY 3 suggestions, 3 major expenses, and 3 major incomes based on the analyzed data.
  `;

  const maxRetries = 3;
  let retries = 0;
  let analysisJson;

  while (retries < maxRetries) {
    try {
      console.log(`Attempt ${retries + 1} to fetch data from Gemini API`);
      const requestBody = {
        contents: [
          {
            parts: [
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.9,
          topK: 1,
          topP: 1,
          maxOutputTokens: 2048,
          stopSequences: []
        },
        safetySettings: [
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_MEDIUM_AND_ABOVE"
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_MEDIUM_AND_ABOVE"
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_MEDIUM_AND_ABOVE"
          },
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_MEDIUM_AND_ABOVE"
          },
          {
            category: "HARM_CATEGORY_CIVIC_INTEGRITY",
            threshold: "BLOCK_MEDIUM_AND_ABOVE"
          }
        ]
      };

      console.log("Request body:", JSON.stringify(requestBody, null, 2));

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      const responseData = await response.text();
      console.log("Raw API Response:", responseData);

      if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}, statusText: ${response.statusText}`);
        console.error(`Error body: ${responseData}`);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      let data;
      try {
        data = JSON.parse(responseData);
      } catch (jsonError) {
        console.error("Error parsing JSON response:", jsonError);
        throw new Error("Invalid JSON response from API");
      }

      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0].text) {
        console.error("Invalid response format from Gemini API:", JSON.stringify(data, null, 2));
        throw new Error("Invalid response format from Gemini API");
      }

      const analysisText = data.candidates[0].content.parts[0].text;
      console.log("Analysis text:", analysisText);
      
      try {
        analysisJson = JSON.parse(analysisText);
      } catch (jsonError) {
        console.error("Error parsing JSON:", jsonError);
        console.error("Raw response:", analysisText);
        throw new Error("Invalid JSON in API response content");
      }
      
      const ensureThreeItems = (array, defaultItems) => {
        if (!Array.isArray(array) || array.length === 0) {
          return defaultItems;
        }
        return array.length < 3 ? [...array, ...defaultItems.slice(0, 3 - array.length)] : array.slice(0, 3);
      };

      const defaultExpenses = [
        "Miscellaneous expense",
        "Other expense",
        "Unspecified expense"
      ];

      const defaultIncomes = [
        "Miscellaneous income",
        "Other income",
        "Unspecified income"
      ];

      const defaultSuggestions = [
        "Consider creating a budget to track your expenses more effectively",
        "Look for areas where you can reduce unnecessary spending",
        "Try to increase your savings by setting aside a portion of your income each month"
      ];

      analysisJson = {
        totalTransactions: analysisJson.totalTransactions || "N/A",
        totalDebits: analysisJson.totalDebits || "N/A",
        totalCredits: analysisJson.totalCredits || "N/A",
        majorExpenses: ensureThreeItems(analysisJson.majorExpenses, defaultExpenses),
        majorIncomes: ensureThreeItems(analysisJson.majorIncomes, defaultIncomes),
        suggestions: ensureThreeItems(analysisJson.suggestions, defaultSuggestions)
      };

      break;
    } catch (err) {
      console.error(`Attempt ${retries + 1} failed:`, err);
      retries++;
      if (retries >= maxRetries) {
        console.error("Max retries reached. Sending error response.");
        return res.status(500).json({ 
          error: "Failed to process the request after multiple attempts",
          details: err.message
        });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  res.json(analysisJson);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});