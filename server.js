const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
const cors = require('cors');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory queue implementation
class SimpleQueue {
  constructor(concurrency = 5) {
    this.queue = [];
    this.processing = 0;
    this.maxConcurrency = concurrency;
  }

  add(task) {
    return new Promise((resolve) => {
      const id = uuidv4();
      this.queue.push({
        id,
        task,
        resolve
      });
      this.processNext();
      return id;
    });
  }

  async processNext() {
    if (this.processing >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    this.processing++;
    const item = this.queue.shift();
    
    try {
      const result = await item.task();
      item.resolve({ success: true, result });
    } catch (error) {
      item.resolve({ success: false, error: error.message });
    } finally {
      this.processing--;
      // Process next item if available
      this.processNext();
    }
  }

  getStats() {
    return {
      queued: this.queue.length,
      processing: this.processing
    };
  }
}

// Create queues with different concurrency limits
const uploadQueue = new SimpleQueue(10); // Higher concurrency for uploads
const processingQueue = new SimpleQueue(3); // Lower concurrency for intensive operations

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'ssl', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl', 'cert.pem'))
};

// Configure middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static('public'));

// Add basic rate limiting
const rateLimit = require('express-rate-limit');
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // 50 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Apply rate limiter to all API routes
app.use('/api', apiLimiter);

// Set up file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate a unique filename with timestamp
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const originalName = file.originalname;
    cb(null, `${timestamp}-${originalName}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Only accept CSV files
    if (path.extname(file.originalname).toLowerCase() === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Job tracking map
const jobStatus = new Map();

// API endpoint to receive CSV files from Unity
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const jobId = uuidv4();
  jobStatus.set(jobId, 'queued');

  // Extract metadata if provided
  const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
  
  // Return immediately with job ID
  res.status(202).json({
    message: 'File upload received and queued for processing',
    jobId,
    filename: req.file.filename
  });

  // Add file processing to queue
  uploadQueue.add(async () => {
    try {
      jobStatus.set(jobId, 'processing');
      
      // Save metadata alongside the file if provided
      if (Object.keys(metadata).length > 0) {
        const metadataPath = req.file.path + '.meta.json';
        await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      }
      
      jobStatus.set(jobId, 'completed');
      return { success: true };
    } catch (error) {
      jobStatus.set(jobId, 'failed');
      console.error(`Error processing file ${req.file.filename}:`, error);
      return { success: false, error: error.message };
    }
  });
});

// API endpoint to check job status
app.get('/api/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const status = jobStatus.get(jobId) || 'not_found';
  
  res.status(status === 'not_found' ? 404 : 200).json({ 
    jobId, 
    status 
  });
});

// API endpoint to check server health
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    queues: {
      uploads: uploadQueue.getStats(),
      processing: processingQueue.getStats()
    }
  });
});

// API endpoint to generate a unique participant ID
app.get('/api/participantID', (req, res) => {
  const participantID = uuidv4();
  res.status(200).json({ participantID });
});

// API endpoint to get a list of all uploaded files
app.get('/api/files', async (req, res) => {
  const uploadDir = path.join(__dirname, 'uploads');
  
  if (!fs.existsSync(uploadDir)) {
    return res.json({ files: [] });
  }
  
  try {
    const fileList = await fs.promises.readdir(uploadDir);
    const files = fileList
      .filter(file => path.extname(file).toLowerCase() === '.csv')
      .map(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        
        // Check if metadata exists for this file
        let metadata = {};
        const metadataPath = filePath + '.meta.json';
        if (fs.existsSync(metadataPath)) {
          try {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          } catch (err) {
            console.error(`Error reading metadata for ${file}:`, err);
          }
        }
        
        return {
          name: file,
          path: `/api/download/${file}`,
          size: stats.size,
          created: stats.birthtime,
          metadata
        };
      });
    
    res.json({ files });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Error listing files' });
  }
});

// API endpoint to download a specific file
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.download(filePath);
});

// API endpoint to download all files as a zip (direct, no queue)
app.get('/api/download-all', (req, res) => {
  const archiver = require('archiver');
  const uploadDir = path.join(__dirname, 'uploads');
  
  if (!fs.existsSync(uploadDir)) {
    return res.status(404).json({ error: 'No files found' });
  }
  
  const archive = archiver('zip', {
    zlib: { level: 9 } // Maximum compression
  });
  
  // Set the headers
  res.attachment('all-experiment-data.zip');
  
  // Pipe the archive to the response
  archive.pipe(res);
  
  // Add all CSV files to the archive
  const files = fs.readdirSync(uploadDir)
    .filter(file => path.extname(file).toLowerCase() === '.csv');
  
  files.forEach(file => {
    const filePath = path.join(uploadDir, file);
    archive.file(filePath, { name: file });
    
    // Also include metadata if it exists
    const metadataPath = filePath + '.meta.json';
    if (fs.existsSync(metadataPath)) {
      archive.file(metadataPath, { name: file + '.meta.json' });
    }
  });
  
  // Finalize the archive
  archive.finalize();
});

const previewResults = new Map();

// Update the /api/preview route
app.get('/api/preview', async (req, res) => {
  const jobId = uuidv4();
  jobStatus.set(jobId, 'queued');

  // Return immediately with job ID
  res.status(202).json({
    message: 'Preview generation has been queued',
    jobId
  });

  // Add preview generation to queue
  processingQueue.add(async () => {
    try {
      jobStatus.set(jobId, 'processing');
      const uploadDir = path.join(__dirname, 'uploads');
      
      if (!fs.existsSync(uploadDir)) {
        previewResults.set(jobId, { files: [], headers: [], preview: [] });
        jobStatus.set(jobId, 'completed');
        return;
      }
      
      const files = fs.readdirSync(uploadDir)
        .filter(file => path.extname(file).toLowerCase() === '.csv');
      
      if (files.length === 0) {
        previewResults.set(jobId, { files: [], headers: [], preview: [] });
        jobStatus.set(jobId, 'completed');
        return;
      }
      
// Get the first file to extract headers
      const firstFilePath = path.join(uploadDir, files[0]);
      let headers = [];
      let preview = [];
      
      // Read headers from the first file
      const headerStream = fs.createReadStream(firstFilePath)
        .pipe(csv());
      
      // Get headers from the first row
      for await (const row of headerStream) {
        headers = Object.keys(row);
        break;
      }
      
      // Collect preview data from up to 5 files, 10 rows each
      const filesToPreview = files.slice(0, 5);
      for (const file of filesToPreview) {
        const filePath = path.join(uploadDir, file);
        let rowCount = 0;
        
        const rows = await new Promise((resolve, reject) => {
          const results = [];
          fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => {
              if (rowCount < 10) {
                results.push({...data, _file: file});
                rowCount++;
              }
            })
            .on('end', () => resolve(results))
            .on('error', reject);
        });
        
        preview = preview.concat(rows);
      }      
      previewResults.set(jobId, {
        files: files,
        headers: headers,
        preview: preview.slice(0, 50) // Limit to 50 rows total
      });
      
      jobStatus.set(jobId, 'completed');
    } catch (error) {
      console.error('Error generating preview:', error);
      jobStatus.set(jobId, 'failed');
    }
  });
});

// The /api/preview/:jobId route can now access previewResults
app.get('/api/preview/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const status = jobStatus.get(jobId);
  
  if (!status || status === 'not_found') {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  if (status === 'queued' || status === 'processing') {
    return res.status(202).json({ 
      message: 'Preview is still being generated', 
      status 
    });
  }
  
  if (status === 'failed') {
    return res.status(500).json({ error: 'Preview generation failed' });
  }
  
  const preview = previewResults.get(jobId);
  if (!preview) {
    return res.status(404).json({ error: 'Preview not found' });
  }
  
  res.json(preview);
});

// Add memory usage monitoring endpoint
app.get('/api/metrics', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const uptime = process.uptime();
  
  const metrics = {
    memoryUsage: {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
      external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
    },
    uptime: `${Math.round(uptime / 60)} minutes`,
    queueStats: {
      uploadQueue: uploadQueue.getStats(),
      processingQueue: processingQueue.getStats()
    }
  };
  
  res.json(metrics);
});

// Cleanup job to remove old job statuses (run every hour)
setInterval(() => {
  const now = Date.now();
  const expiryTime = 3600000; // 1 hour in milliseconds
  
  // Clean up job status
  for (const [jobId, status] of jobStatus.entries()) {
    // Extract timestamp from UUID if possible, otherwise assume it's old
    const timestamp = parseInt(jobId.split('-')[0], 16);
    if (isNaN(timestamp) || now - timestamp > expiryTime) {
      jobStatus.delete(jobId);
    }
  }
  
}, 3600000); // Run every hour

// Start the server
https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`HTTPS server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});