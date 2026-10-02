{{- define "vks-fleet.name" -}}{{ .Release.Name | trunc 50 | trimSuffix "-" }}{{- end }}
{{- define "vks-fleet.headlamp" -}}{{ include "vks-fleet.name" . }}-headlamp{{- end }}
{{- define "vks-fleet.kubeconfig" -}}{{ include "vks-fleet.name" . }}-kubeconfig{{- end }}
{{- define "vks-fleet.labels" -}}
app.kubernetes.io/part-of: vks-fleet
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}
{{- define "vks-fleet.pluginUrl" -}}
{{- default (printf "https://github.com/avnish80/vks-fleet/releases/download/v%s/vks-fleet.tar.gz" .Chart.AppVersion) .Values.plugin.downloadUrl -}}
{{- end }}
{{- define "vks-fleet.caSecret" -}}{{ default .Values.caSecret .Values.tls.caSecret }}{{- end }}
{{- define "vks-fleet.supervisorInsecure" -}}{{ or .Values.tls.insecure .Values.refresher.insecure }}{{- end }}
{{- define "vks-fleet.vcenterInsecure" -}}{{ or .Values.tls.insecure .Values.collector.insecure }}{{- end }}

