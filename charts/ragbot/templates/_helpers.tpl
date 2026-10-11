{{- define "ragbot.role" -}}
{{- if not (has .Values.role (list "onprem" "rosa")) -}}
{{- fail (printf "role must be onprem or rosa, got %q: pass values-onprem.yaml or values-rosa.yaml" .Values.role) -}}
{{- end -}}
{{- .Values.role -}}
{{- end -}}

{{- define "ragbot.labels" -}}
app.kubernetes.io/part-of: ragbot
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
ragbot.io/role: {{ .Values.role }}
{{- end -}}

{{- define "ragbot.selector" -}}
app.kubernetes.io/part-of: ragbot
app.kubernetes.io/name: {{ . }}
{{- end -}}

{{- define "ragbot.image" -}}
{{ .repository }}:{{ .tag }}
{{- end -}}

{{- define "ragbot.pullSecrets" -}}
{{- with .Values.images.pullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Restricted-v2 friendly container security context. No runAsUser: OpenShift assigns one. */}}
{{- define "ragbot.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  runAsNonRoot: true
  capabilities: {drop: [ALL]}
  seccompProfile: {type: RuntimeDefault}
{{- end -}}

{{- define "ragbot.wave" -}}
argocd.argoproj.io/sync-wave: {{ . | quote }}
{{- end -}}

{{/* The bench's nginx Service, created by frappe-operator. */}}
{{- define "ragbot.frappeInternalHost" -}}
{{ .Values.onprem.bench.name }}-nginx
{{- end -}}

{{- define "ragbot.frappeInternalURL" -}}
http://{{ include "ragbot.frappeInternalHost" . }}:8080
{{- end -}}



{{- /* Mounts and env copied from frappe-operator's own worker Deployments
       (controllers/frappebench_workers.go), so these pods see the same bench. */}}
{{- define "ragbot.benchContainerCommon" -}}
image: {{ include "ragbot.image" .Values.images.bench }}
imagePullPolicy: {{ .Values.images.pullPolicy }}
env:
  - {name: USER, value: frappe}
  - {name: PYTHONPATH, value: "/tmp/pip:/home/frappe/frappe-bench/sites/apps"}
volumeMounts:
  - {name: sites, mountPath: /home/frappe/frappe-bench/sites, subPath: frappe-sites}
  - {name: sites, mountPath: /home/frappe/frappe-bench/sites/assets, subPath: frappe-sites/assets}
{{ include "ragbot.containerSecurity" . }}
{{- end -}}


{{/* An Ollama container from images/ollama-model. Args: dict root, model, extraEnv. */}}
{{- define "ragbot.ollamaContainer" -}}
{{- $root := .root -}}
image: {{ include "ragbot.image" .image }}
imagePullPolicy: {{ $root.Values.images.pullPolicy }}
{{- with .extraEnv }}
env:
  {{- range $k, $v := . }}
  - {name: {{ $k }}, value: {{ $v | quote }}}
  {{- end }}
{{- end }}
ports:
  - {name: http, containerPort: 11434}
# Fails (and so restarts, visibly) if the image does not hold the model the
# chart was told to serve: image tag and llm.model drifted apart.
startupProbe:
  exec:
    command: [ollama, show, {{ .model | quote }}]
  periodSeconds: 5
  failureThreshold: 60
readinessProbe:
  httpGet: {path: /api/version, port: http}
  periodSeconds: 10
livenessProbe:
  httpGet: {path: /api/version, port: http}
  periodSeconds: 30
  failureThreshold: 5
{{ include "ragbot.containerSecurity" $root }}
{{- end -}}


{{/* Names the MetalLB address answers to: the hostnames, plus the pinned IP. JSON list. */}}
{{- define "ragbot.lbAliases" -}}
{{- $lb := .Values.onprem.frontend.loadBalancer -}}
{{- $names := list -}}
{{- if $lb.enabled -}}
{{- $names = concat $names $lb.hostnames -}}
{{- with $lb.ip }}{{ $names = append $names . }}{{ end -}}
{{- end -}}
{{- $names | uniq | toJson -}}
{{- end -}}

{{/* Browser origins the agent accepts: the Route, and each LB name with its port. JSON list. */}}
{{- define "ragbot.corsOrigins" -}}
{{- $o := .Values.onprem -}}
{{- $lb := $o.frontend.loadBalancer -}}
{{- $origins := list -}}
{{- if $o.frontend.route.enabled -}}
{{- $origins = append $origins (printf "https://%s" $o.siteHost) -}}
{{- end -}}
{{- range include "ragbot.lbAliases" . | fromJsonArray -}}
{{- $origins = append $origins (printf "http://%s:%v" . $lb.port) -}}
{{- end -}}
{{- $origins | toJson -}}
{{- end -}}
