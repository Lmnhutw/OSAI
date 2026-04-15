package worker

import (
	"fmt"
	"path/filepath"
	"strings"

	execresult "execution-go/internal/result"
)

func validateChangedFiles(plan executionPlan, spec ExecutionSpec, changedFiles []string) ([]execresult.SafetyCheck, execresult.FailureClassification, string) {
	checks := make([]execresult.SafetyCheck, 0, 3)
	if len(changedFiles) == 0 {
		checks = append(checks, passedCheck("changed_files_scope", "No tracked file changes were detected."))
		return checks, execresult.FailureClassificationNone, ""
	}

	if !plan.WriteEnabled {
		reason := "Read-only or dry-run execution produced tracked file changes."
		checks = append(checks, failedCheck("changed_files_scope", reason))
		return checks, execresult.FailureClassificationAutonomyForbidden, reason
	}

	for _, path := range changedFiles {
		if !isSafeRelativePath(path) {
			reason := fmt.Sprintf("Changed file %q is outside the safe workspace-relative path boundary.", path)
			checks = append(checks, failedCheck("changed_files_workspace_boundary", reason))
			return checks, execresult.FailureClassificationPolicyRejected, reason
		}
	}
	checks = append(checks, passedCheck("changed_files_workspace_boundary", "All changed files stayed inside the workspace-relative path boundary."))

	allowedPaths := cleanStrings(firstSlice(spec.Contract.Write.AllowedPaths, spec.AllowedPaths))
	if len(allowedPaths) > 0 {
		disallowed := make([]string, 0)
		for _, path := range changedFiles {
			if !matchesAnyPath(path, allowedPaths) {
				disallowed = append(disallowed, path)
			}
		}
		if len(disallowed) > 0 {
			reason := "Tracked changes exceeded the allowed write paths: " + strings.Join(disallowed, ", ")
			checks = append(checks, failedCheck("changed_files_allowed_paths", reason))
			return checks, execresult.FailureClassificationPolicyRejected, reason
		}
		checks = append(checks, passedCheck("changed_files_allowed_paths", "All changed files stayed within the allowed write paths."))
	}

	if len(spec.PolicySnapshot.SensitivePaths) > 0 {
		blocked := make([]string, 0)
		for _, path := range changedFiles {
			if matchesAnyPath(path, spec.PolicySnapshot.SensitivePaths) && !matchesAnyPath(path, allowedPaths) {
				blocked = append(blocked, path)
			}
		}
		if len(blocked) > 0 {
			reason := "Tracked changes touched sensitive paths without an explicit write allowance: " + strings.Join(blocked, ", ")
			checks = append(checks, failedCheck("changed_files_sensitive_scope", reason))
			return checks, execresult.FailureClassificationSensitiveScopeBlocked, reason
		}
		checks = append(checks, passedCheck("changed_files_sensitive_scope", "No changed files violated the policy snapshot sensitive path restrictions."))
	}

	return checks, execresult.FailureClassificationNone, ""
}

func isSafeRelativePath(path string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	path = filepath.ToSlash(path)
	if strings.HasPrefix(path, "/") || filepath.IsAbs(path) {
		return false
	}
	cleaned := filepath.ToSlash(filepath.Clean(path))
	return cleaned != ".." && !strings.HasPrefix(cleaned, "../")
}

func matchesAnyPath(path string, allowed []string) bool {
	if len(allowed) == 0 {
		return false
	}
	path = filepath.ToSlash(filepath.Clean(strings.TrimSpace(path)))
	for _, candidate := range allowed {
		candidate = filepath.ToSlash(filepath.Clean(strings.TrimSpace(candidate)))
		if candidate == "." || candidate == "" {
			return true
		}
		if path == candidate || strings.HasPrefix(path, candidate+"/") {
			return true
		}
	}
	return false
}
