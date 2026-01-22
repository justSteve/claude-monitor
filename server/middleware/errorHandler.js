/**
 * Global error handling middleware
 */
function errorHandler(err, req, res, next) {
    console.error('Error:', err.message);
    if (process.env.LOG_LEVEL === 'debug') {
        console.error(err.stack);
    }

    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    res.status(statusCode).json({
        error: true,
        message,
        code: err.code || 'INTERNAL_ERROR',
        ...(process.env.LOG_LEVEL === 'debug' && { stack: err.stack })
    });
}

export default errorHandler;
