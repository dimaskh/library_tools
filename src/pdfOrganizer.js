import { config } from "dotenv";
import fs from "fs-extra";
import os from "os";
import pLimit from "p-limit";
import path from "path";
import { PDFExtract } from "pdf.js-extract";
import ProgressBar from "progress";

// Initialize dotenv
config();

const pdfExtract = new PDFExtract();
// Use number of CPU cores * 2 for maximum parallelization
const MAX_CONCURRENT =
  parseInt(process.env.MAX_CONCURRENT) || os.cpus().length * 2;
const limit = pLimit(MAX_CONCURRENT);
const sourceDir = process.env.PDF_SOURCE_DIR;

if (!sourceDir) {
  console.error("Error: PDF_SOURCE_DIR not set in .env file");
  process.exit(1);
}

async function extractPdfMetadata(filePath) {
  try {
    const data = await pdfExtract.extract(filePath, {});
    const metadata = data.meta || {};

    // Try to extract information from PDF metadata
    return {
      title: metadata.info?.Title,
      author: metadata.info?.Author,
      year: metadata.info?.CreationDate
        ? new Date(metadata.info.CreationDate).getFullYear()
        : null,
    };
  } catch (error) {
    console.error(`Error reading metadata from ${filePath}:`, error.message);
    return null;
  }
}

function cleanupText(text) {
  if (!text) return text;
  // Remove extra spaces, dots, underscores
  return text
    .replace(/[_\.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidAuthorName(text) {
  if (!text) return false;

  // Remove common punctuation for checking
  const cleanText = text.replace(/[.,\s-]/g, "");

  // Check for repeated characters that might indicate encoding issues or garbage
  if (/(.)\1{2,}/.test(cleanText)) return false;

  // Check if the text contains only weird symbols
  const weirdSymbolsOnly = /^[^A-Za-zА-Яа-я0-9]+$/.test(cleanText);
  if (weirdSymbolsOnly) return false;

  // Ensure there's at least one letter
  const hasLetters = /[A-Za-zА-Яа-я]/.test(cleanText);
  if (!hasLetters) return false;

  // Check for unreasonably long or short names
  if (cleanText.length < 2 || cleanText.length > 100) return false;

  // Split into parts and check for suspicious patterns
  const parts = text.split(/\s*[-,]\s*/);

  // Check for repeated parts or parts that are too similar
  const uniqueParts = new Set(parts.map((p) => p.toLowerCase()));
  if (uniqueParts.size < parts.length) return false;

  // Check for too many parts
  if (parts.length > 6) return false; // Allow for full names like "James Clerk Maxwell"

  // Check for username-like patterns (e.g., "jross1", "user123")
  const usernamePattern = /^[a-z]+\d+$/i;
  const hasUsernamePart = parts.some((part) => usernamePattern.test(part));
  if (hasUsernamePart) return false;

  // Check for parts that look like real names (more permissive)
  const namePattern =
    /^[A-ZА-Я][a-zа-я]+$|^[A-ZА-Я]\.$|^[A-ZА-Я]$|^[A-ZА-Я][a-zа-я]+[A-ZА-Яa-zа-я\s]*$/;
  const hasValidNamePart = parts.some((part) => namePattern.test(part));
  if (!hasValidNamePart) return false;

  // Check for parts that are too similar (but be more lenient)
  for (let i = 0; i < parts.length - 1; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (parts[i].toLowerCase() === parts[j].toLowerCase()) return false;
      // Only check similarity for short parts to avoid false positives
      if (parts[i].length < 10 && parts[j].length < 10) {
        const similarity = levenshteinDistance(parts[i], parts[j]);
        if (similarity <= 1) return false; // Parts are too similar
      }
    }
  }

  return true;
}

// Helper function to calculate Levenshtein distance between two strings
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1)
    .fill()
    .map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] =
          1 +
          Math.min(
            dp[i - 1][j], // deletion
            dp[i][j - 1], // insertion
            dp[i - 1][j - 1] // substitution
          );
      }
    }
  }

  return dp[m][n];
}

function isLikelyAuthor(text) {
  if (!isValidAuthorName(text)) return false;

  // Common patterns that indicate an author:
  // - Contains initials (e.g., "R G", "J.K.", "А.С.")
  // - Short name with dots or commas (e.g., "Smith J.", "Doe, John")
  // - 2-3 words with at least one being 1-2 characters (likely initial)
  const words = text.split(/\s+/);
  const hasInitials = words.some((word) =>
    /^[A-ZА-Я]\.$|^[A-ZА-Я]$/.test(word)
  );
  const hasCommaOrDot = /[.,]/.test(text);
  const isShortName =
    words.length <= 3 && words.some((word) => word.length <= 2);

  return (
    hasInitials ||
    (hasCommaOrDot && isShortName) ||
    (words.length <= 3 && hasInitials)
  );
}

function parseFilename(filename) {
  // Remove file extension and clean up the text
  const nameWithoutExt = cleanupText(path.parse(filename).name);

  // Common publisher prefixes to remove
  const publishersToRemove = [
    "Dorling Kindersley",
    "DK",
    "McGraw-Hill",
    "McGraw Hill",
    "O'Reilly",
    "Packt",
    "Apress",
    "Manning",
    "Wiley",
  ];

  let cleanName = nameWithoutExt;
  publishersToRemove.forEach((publisher) => {
    cleanName = cleanName.replace(
      new RegExp("^" + publisher + "\\.?\\s*", "i"),
      ""
    );
  });

  // Extract year first - it's the most reliable part
  const yearPattern = /[\[\(]?(\d{4})[\]\)]?(?:\s*)?$/;
  const yearMatch = cleanName.match(yearPattern);
  const year = yearMatch ? parseInt(yearMatch[1]) : null;

  // Remove the year from the name for further parsing
  if (year) {
    cleanName = cleanName.replace(yearPattern, "").trim();
  }

  // Try to match patterns like "Author - Title" or "Title - Author"
  const patterns = [
    // Author - Title
    /^([A-Za-zА-Яа-я][A-Za-zА-Яа-я\s,.]{0,50}?)\s+-\s+(.+?)$/,
    // Title - Author
    /^(.+?)\s+-\s+([A-Za-zА-Яа-я][A-Za-zА-Яа-я\s,.]{0,50}?)$/,
    // Title by Author
    /^(.+?)\s+by\s+([A-Za-zА-Яа-я][A-Za-zА-Яа-я\s,.]+?)$/i,
    // Title (Author)
    /^(.+?)\s+\(([A-Za-zА-Яа-я][A-Za-zА-Яа-я\s,.]+?)\)$/,
    // Single part
    /^(.+?)$/,
  ];

  for (const pattern of patterns) {
    const match = cleanName.match(pattern);
    if (match) {
      // If it's a pattern with two parts
      if (match.length > 2) {
        const firstPart = match[1].trim();
        const secondPart = match[2].trim();

        // Check which part is more likely to be the author
        const isFirstPartAuthor = isLikelyAuthor(firstPart);
        const isSecondPartAuthor = isLikelyAuthor(secondPart);

        // If we can identify the author part
        if (isFirstPartAuthor || isSecondPartAuthor) {
          // Always return with title first, then author
          if (isFirstPartAuthor) {
            return {
              title: secondPart,
              author: firstPart,
              year: year,
            };
          } else {
            return {
              title: firstPart,
              author: secondPart,
              year: year,
            };
          }
        }

        // If we can't clearly identify the author, assume the shorter part is the author
        const useFirstAsAuthor = firstPart.length <= secondPart.length;
        return {
          title: useFirstAsAuthor ? secondPart : firstPart,
          author: useFirstAsAuthor ? firstPart : secondPart,
          year: year,
        };
      }
      // If it's just a single part
      else {
        return {
          title: match[1].trim(),
          author: null,
          year: year,
        };
      }
    }
  }

  // If no pattern matches, return the whole name as title
  return {
    title: cleanName,
    author: null,
    year: year,
  };
}

function formatAuthorName(author) {
  if (!author) return author;

  // Split by common separators (comma and spaces)
  const parts = author.split(/\s*[,]\s*|\s+/);

  // Check if we have initials before the last name
  if (parts.length >= 2) {
    const hasInitialsFirst = parts
      .slice(0, -1)
      .every((part) => /^[A-ZА-Я]\.?$/.test(part));
    if (hasInitialsFirst) {
      // Format: "А Б Иванов" -> "А. Б. Иванов"
      const initials = parts
        .slice(0, -1)
        .map((part) => part.replace(/\.$/, "") + ".");
      const lastName = parts[parts.length - 1];
      return [...initials, lastName].join(" ");
    }
  }

  // Group parts into author names
  const authors = [];
  let currentAuthor = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // If it's a single letter (initial), add a dot if missing
    if (/^[A-ZА-Я]$/.test(part)) {
      currentAuthor.push(part + ".");
    } else {
      currentAuthor.push(part);
    }

    // Check if we've reached the end of an author's name
    const nextPart = parts[i + 1];
    const isLastPart = i === parts.length - 1;
    const nextPartIsNewAuthor =
      nextPart && /^[A-ZА-Я][a-zа-я]+$/.test(nextPart);

    if (isLastPart || nextPartIsNewAuthor) {
      const authorName = currentAuthor.join(" ").trim();
      if (authorName) {
        authors.push(authorName);
      }
      currentAuthor = [];
    }
  }

  // If we have multiple authors, ensure proper comma separation
  if (authors.length > 1) {
    // Join all authors with commas
    return authors
      .map((a, i) => {
        // Add comma after each author except the last one
        return i < authors.length - 1 ? a + "," : a;
      })
      .join(" ")
      .replace(/\s*,\s*/g, ", ") // Normalize comma spacing
      .trim();
  }

  // Single author case
  return authors[0] || "";
}

function generateNewFilename(metadata) {
  if (!metadata.title) return null;

  // Clean up the metadata
  const title = cleanupText(metadata.title)
    .replace(/\s*-\s*$/, "") // Remove trailing dashes
    .replace(/^\s*-\s*/, ""); // Remove leading dashes

  let author = cleanupText(metadata.author);

  if (!title) return null;

  // Build the new filename
  let newName = title;

  // Only add author if it's valid and won't create double dashes
  if (author && isValidAuthorName(author)) {
    author = formatAuthorName(author)
      .replace(/\s*-\s*$/, "") // Remove trailing dashes
      .replace(/^\s*-\s*/, ""); // Remove leading dashes

    // Check if adding author would create double dashes
    if (author && !newName.endsWith("-") && !author.startsWith("-")) {
      newName += ` - ${author}`;
    }
  }

  if (metadata.year) {
    // Always use square brackets for year
    newName += ` [${metadata.year}]`;
  }

  // Replace invalid characters and clean up
  newName = newName
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+-\s+-\s+/g, " - ") // Replace double dashes with single dash
    .replace(/\s+/g, " ") // Remove multiple spaces
    .trim();

  // Final check for any remaining double dashes or suspicious patterns
  if (
    newName.includes(" - - ") ||
    newName.includes("jross") ||
    /(.)\1{3,}/.test(newName)
  ) {
    // If we still have issues, use just the title and year
    newName = title;
    if (metadata.year) {
      newName += ` [${metadata.year}]`;
    }
  }

  return newName + ".pdf";
}

async function processPdfFile(filePath) {
  try {
    const filename = path.basename(filePath);

    // Try to parse from filename first
    const filenameMetadata = parseFilename(filename);
    let metadata = { ...filenameMetadata };

    // Only try PDF metadata for missing information
    if (!metadata.author) {
      const pdfMetadata = await extractPdfMetadata(filePath);
      if (pdfMetadata) {
        metadata = {
          // Keep filename title and year if they exist
          title: metadata.title || pdfMetadata.title,
          author: pdfMetadata.author || metadata.author,
          year: metadata.year || pdfMetadata.year,
        };
      }
    }

    if (!metadata.title) {
      return;
    }

    const newFilename = generateNewFilename(metadata);
    if (!newFilename || newFilename === filename) {
      return;
    }

    const dirPath = path.dirname(filePath);
    const newPath = path.join(dirPath, newFilename);

    if ((await fs.pathExists(newPath)) && newPath !== filePath) {
      return;
    }

    await fs.rename(filePath, newPath);
    console.log(`\nRenamed: ${filename} -> ${newFilename}`);
  } catch (error) {
    console.error(`\nError processing ${filePath}:`, error.message);
  }
}

async function getAllPdfFiles(dir) {
  const pdfFiles = [];
  const stack = [dir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const items = await fs.readdir(currentDir, { withFileTypes: true });

    await Promise.all(
      items.map(async (item) => {
        const itemPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          stack.push(itemPath);
        } else if (
          item.isFile() &&
          path.extname(item.name).toLowerCase() === ".pdf"
        ) {
          pdfFiles.push(itemPath);
        }
      })
    );
  }

  return pdfFiles;
}

async function processFiles(pdfFiles) {
  // Create progress bar
  const progressBar = new ProgressBar(
    "Processing PDF files [:bar] :current/:total :percent :file",
    {
      complete: "=",
      incomplete: " ",
      width: 30,
      total: pdfFiles.length,
    }
  );

  // Process files in parallel with progress bar
  const processWithProgress = async (filePath) => {
    try {
      const result = await processPdfFile(filePath);
      progressBar.tick({
        file: path.basename(filePath),
      });
      return result;
    } catch (error) {
      console.error(`\nError processing ${filePath}:`, error.message);
    }
  };

  // Process all files in parallel with concurrency limit
  await Promise.all(
    pdfFiles.map((filePath) => limit(() => processWithProgress(filePath)))
  );
}

// Main execution
console.log(`Starting PDF organization in: ${sourceDir}`);
console.log(`Using ${MAX_CONCURRENT} concurrent operations`);

getAllPdfFiles(sourceDir)
  .then(async (pdfFiles) => {
    console.log(`Found ${pdfFiles.length} PDF files`);
    await processFiles(pdfFiles);
    console.log("\nPDF organization completed");
  })
  .catch((error) => console.error("\nError:", error.message));
