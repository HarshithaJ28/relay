{{- define "relay.labels" -}}
app.kubernetes.io/part-of: relay
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* Selector labels for one component: relay.selector (dict "root" $ "component" "worker") */}}
{{- define "relay.selector" -}}
app.kubernetes.io/name: relay
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "relay.image" -}}
{{ .root.Values.images.registry }}/{{ .name }}:{{ .root.Values.images.tag }}
{{- end }}

{{/* Pod security settings shared by every Relay container. */}}
{{- define "relay.podSecurity" -}}
automountServiceAccountToken: false
{{- with .Values.images.pullSecrets }}
imagePullSecrets:
  {{- range . }}
  - name: {{ . }}
  {{- end }}
{{- end }}
securityContext:
  runAsNonRoot: true
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{- define "relay.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
{{- end }}

{{/* Environment that builds a role's DSN from its password in the Secret. */}}
{{- define "relay.dbEnv" -}}
- name: RELAY_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .root.Values.secrets.name }}
      key: password-{{ trimPrefix "relay_" .role }}
- name: {{ .var }}
  value: "host={{ .root.Values.database.host }} port={{ .root.Values.database.port }} dbname={{ .root.Values.database.name }} user={{ .role }} password=$(RELAY_DB_PASSWORD) sslmode={{ .root.Values.database.sslmode }}"
{{- end }}

{{- define "relay.valkeyEnv" -}}
- name: RELAY_VALKEY_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.name }}
      key: valkey-password
- name: RELAY_VALKEY_URL
  value: "redis://:$(RELAY_VALKEY_PASSWORD)@{{ .Values.valkey.host }}:{{ .Values.valkey.port }}/0"
{{- end }}

{{- define "relay.amqpEnv" -}}
- name: RELAY_AMQP_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.name }}
      key: amqp-password
- name: RELAY_AMQP
  value: "amqp://{{ .Values.amqp.user }}:$(RELAY_AMQP_PASSWORD)@{{ .Values.amqp.host }}:{{ .Values.amqp.port }}/"
{{- end }}

{{- define "relay.np.dns" -}}
- to:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: {{ .Values.networkPolicy.dns.namespace }} }
      podSelector:
        matchLabels:
          {{- toYaml .Values.networkPolicy.dns.podLabels | nindent 10 }}
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
{{- end }}
{{- define "relay.np.to" -}}
- to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/part-of: relay
          app.kubernetes.io/component: {{ .component }}
  ports:
    - { protocol: TCP, port: {{ .port }} }
{{- end }}
