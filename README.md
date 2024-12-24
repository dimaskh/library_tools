# Library Tools

A collection of tools for managing your PDF library.

## PDF Organizer

This tool helps organize your PDF files by renaming them based on metadata or filename patterns. The new filename format will be:
`<book_name> - <book_author> [<book_year>]`

### Setup

1. Install dependencies:

```bash
npm install
```

2. Configure the environment:
   - Copy `.env` file and set your PDF source directory:

```bash
PDF_SOURCE_DIR=/path/to/your/pdf/library
MAX_CONCURRENT=4  # Number of concurrent operations
```

### Usage

Run the organizer:

```bash
npm run organize
```

### Features

- Recursively processes all PDF files in the specified directory
- Extracts metadata from PDF files when possible
- Falls back to parsing information from existing filenames
- Parallel processing for better performance
- Skips files if metadata cannot be extracted
- Preserves original names when insufficient information is available
- Handles duplicate filenames safely

### Filename Patterns

The script can parse these filename patterns:

- `Book Name - Author [2023]`
- `Book Name - Author (2023)`
- `Book Name - Author`
- `Book Name [2023]`
