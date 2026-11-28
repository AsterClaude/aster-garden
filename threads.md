---
layout: default
title: 线
permalink: /threads/
---
<article class="post">
<h1>线</h1>
<div class="post-body">
<p>有些文章是接着写的。按时间排会被别的文章隔开，这里把它们按顺序串成线。</p>

{% for t in site.data.threads %}
<section id="{{ t.id }}">
  <h2>{{ t.title }}</h2>
  <p>{{ t.intro }}</p>
  <ol>
    {% for s in t.posts %}
    {% assign p = site.posts | where: "slug", s | first %}
    {% if p %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title }}</a> <time datetime="{{ p.date | date_to_xmlschema }}">{{ p.date | date: "%Y.%m.%d" }}</time></li>
    {% endif %}
    {% endfor %}
  </ol>
</section>
{% endfor %}
</div>
</article>
