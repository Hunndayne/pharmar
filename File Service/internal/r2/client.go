package r2

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"file-service/internal/config"
)

// Client wraps the S3-compatible Cloudflare R2 client.
type Client struct {
	s3     *s3.Client
	bucket string
	domain string
}

// New creates a new R2 client using S3-compatible API.
func New(ctx context.Context, cfg config.Config) (*Client, error) {
	r2Resolver := aws.EndpointResolverWithOptionsFunc(
		func(service, region string, options ...any) (aws.Endpoint, error) {
			return aws.Endpoint{
				URL: cfg.R2Endpoint(),
			}, nil
		},
	)

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithEndpointResolverWithOptions(r2Resolver),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.R2AccessKeyID, cfg.R2SecretAccessKey, ""),
		),
		awsconfig.WithRegion("auto"),
	)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg)

	return &Client{
		s3:     client,
		bucket: cfg.R2BucketName,
		domain: cfg.R2PublicDomain,
	}, nil
}

// Upload puts an object into R2.
func (c *Client) Upload(ctx context.Context, key string, body io.Reader, contentType string, size int64) error {
	input := &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		Body:        body,
		ContentType: aws.String(contentType),
	}
	if size > 0 {
		input.ContentLength = aws.Int64(size)
	}

	_, err := c.s3.PutObject(ctx, input)
	if err != nil {
		return fmt.Errorf("r2 put object: %w", err)
	}
	return nil
}

// Delete removes an object from R2.
func (c *Client) Delete(ctx context.Context, key string) error {
	_, err := c.s3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("r2 delete object: %w", err)
	}
	return nil
}

// DeleteMany removes multiple objects from R2.
func (c *Client) DeleteMany(ctx context.Context, keys []string) error {
	for _, key := range keys {
		if err := c.Delete(ctx, key); err != nil {
			return err
		}
	}
	return nil
}

// GetPresignedURL generates a presigned URL for downloading a file.
func (c *Client) GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	presignClient := s3.NewPresignClient(c.s3)

	req, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(expiry))
	if err != nil {
		return "", fmt.Errorf("r2 presign get: %w", err)
	}
	return req.URL, nil
}

// GetPresignedUploadURL generates a presigned URL for uploading a file.
func (c *Client) GetPresignedUploadURL(ctx context.Context, key, contentType string, expiry time.Duration) (string, error) {
	presignClient := s3.NewPresignClient(c.s3)

	input := &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}

	req, err := presignClient.PresignPutObject(ctx, input, s3.WithPresignExpires(expiry))
	if err != nil {
		return "", fmt.Errorf("r2 presign put: %w", err)
	}
	return req.URL, nil
}

// PublicURL returns the public URL for a key, if a public domain is configured.
func (c *Client) PublicURL(key string) string {
	if c.domain != "" {
		return fmt.Sprintf("https://%s/%s", c.domain, key)
	}
	return ""
}

// Download retrieves an object from R2.
func (c *Client) Download(ctx context.Context, key string) (io.ReadCloser, string, error) {
	output, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, "", fmt.Errorf("r2 get object: %w", err)
	}

	ct := "application/octet-stream"
	if output.ContentType != nil {
		ct = *output.ContentType
	}
	return output.Body, ct, nil
}
