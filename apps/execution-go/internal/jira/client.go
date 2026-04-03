package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"execution-go/internal/config"
)

type Issue struct {
	Key     string
	Summary string
	Status  string
	Labels  []string
}

type Client struct {
	baseURL     string
	projectKey  string
	readyLabel  string
	email       string
	apiToken    string
	bearerToken string
	httpClient  *http.Client
}

func NewClient(cfg config.JiraClientConfig) *Client {
	return &Client{
		baseURL:     strings.TrimRight(cfg.BaseURL, "/"),
		projectKey:  strings.TrimSpace(cfg.ProjectKey),
		readyLabel:  strings.TrimSpace(cfg.ReadyLabel),
		email:       strings.TrimSpace(cfg.Email),
		apiToken:    strings.TrimSpace(cfg.APIToken),
		bearerToken: strings.TrimSpace(cfg.BearerToken),
		httpClient: &http.Client{
			Timeout: cfg.RequestTimeout,
		},
	}
}

func (c *Client) SearchReadyIssues(ctx context.Context, maxResults int) ([]Issue, error) {
	jql := fmt.Sprintf(`labels = "%s" AND statusCategory != Done`, c.readyLabel)
	if c.projectKey != "" {
		jql = fmt.Sprintf(`project = "%s" AND %s`, c.projectKey, jql)
	}
	jql += " ORDER BY updated ASC"

	query := url.Values{}
	query.Set("jql", jql)
	query.Set("fields", "summary,status,labels")
	query.Set("maxResults", fmt.Sprintf("%d", maxResults))

	endpoint := c.baseURL + "/rest/api/3/search?" + query.Encode()

	var response struct {
		Issues []struct {
			Key    string `json:"key"`
			Fields struct {
				Summary string `json:"summary"`
				Status  struct {
					Name string `json:"name"`
				} `json:"status"`
				Labels []string `json:"labels"`
			} `json:"fields"`
		} `json:"issues"`
	}

	if err := c.doJSON(ctx, http.MethodGet, endpoint, nil, &response); err != nil {
		return nil, err
	}

	issues := make([]Issue, 0, len(response.Issues))
	for _, issue := range response.Issues {
		issues = append(issues, Issue{
			Key:     issue.Key,
			Summary: issue.Fields.Summary,
			Status:  issue.Fields.Status.Name,
			Labels:  append([]string(nil), issue.Fields.Labels...),
		})
	}

	return issues, nil
}

func (c *Client) TransitionIssue(ctx context.Context, issueKey, targetStatus string) error {
	targetStatus = strings.TrimSpace(targetStatus)
	if issueKey == "" || targetStatus == "" {
		return nil
	}

	transitionsURL := fmt.Sprintf("%s/rest/api/3/issue/%s/transitions", c.baseURL, url.PathEscape(issueKey))

	var transitionsResponse struct {
		Transitions []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"transitions"`
	}

	if err := c.doJSON(ctx, http.MethodGet, transitionsURL, nil, &transitionsResponse); err != nil {
		return err
	}

	var transitionID string
	available := make([]string, 0, len(transitionsResponse.Transitions))
	for _, transition := range transitionsResponse.Transitions {
		available = append(available, transition.Name)
		if strings.EqualFold(transition.Name, targetStatus) {
			transitionID = transition.ID
		}
	}

	if transitionID == "" {
		return fmt.Errorf("jira transition %q not available for %s; available=%s", targetStatus, issueKey, strings.Join(available, ", "))
	}

	body := map[string]any{
		"transition": map[string]string{
			"id": transitionID,
		},
	}

	return c.doJSON(ctx, http.MethodPost, transitionsURL, body, nil)
}

func (c *Client) AddComment(ctx context.Context, issueKey, body string) error {
	issueKey = strings.TrimSpace(issueKey)
	body = strings.TrimSpace(body)
	if issueKey == "" || body == "" {
		return nil
	}

	commentURL := fmt.Sprintf("%s/rest/api/3/issue/%s/comment", c.baseURL, url.PathEscape(issueKey))
	return c.doJSON(ctx, http.MethodPost, commentURL, map[string]any{
		"body": adfDocument(body),
	}, nil)
}

func (c *Client) doJSON(ctx context.Context, method, endpoint string, body any, target any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal jira payload: %w", err)
		}
		reader = strings.NewReader(string(payload))
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return fmt.Errorf("build jira request: %w", err)
	}

	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	if c.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearerToken)
	} else {
		req.SetBasicAuth(c.email, c.apiToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("jira request failed: %w", err)
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read jira response: %w", err)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("jira %s %s returned %d: %s", method, endpoint, resp.StatusCode, strings.TrimSpace(string(rawBody)))
	}

	if target == nil || len(rawBody) == 0 {
		return nil
	}

	if err := json.Unmarshal(rawBody, target); err != nil {
		return fmt.Errorf("decode jira response: %w", err)
	}

	return nil
}

func adfDocument(body string) map[string]any {
	blocks := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n\n")
	content := make([]map[string]any, 0, len(blocks))

	for _, block := range blocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}

		paragraphContent := make([]map[string]any, 0, 8)
		for index, line := range strings.Split(block, "\n") {
			line = strings.TrimRight(line, " ")
			if line == "" {
				continue
			}
			if index > 0 {
				paragraphContent = append(paragraphContent, map[string]any{"type": "hardBreak"})
			}
			paragraphContent = append(paragraphContent, map[string]any{
				"type": "text",
				"text": line,
			})
		}
		if len(paragraphContent) == 0 {
			continue
		}

		content = append(content, map[string]any{
			"type":    "paragraph",
			"content": paragraphContent,
		})
	}

	if len(content) == 0 {
		content = append(content, map[string]any{
			"type": "paragraph",
			"content": []map[string]any{
				{
					"type": "text",
					"text": body,
				},
			},
		})
	}

	return map[string]any{
		"type":    "doc",
		"version": 1,
		"content": content,
	}
}
